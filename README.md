# Background subagents for Pi

Async workers in **unselected tmux windows**, not splits or new tmux sessions. Each worker runs the normal Pi TUI, so inspecting or steering it does not require a separate interface.

## Install and try

Tested with Pi 1.0.2 and tmux 3.7c. Requires the `agent_settled` extension lifecycle, tmux with `new-window -e`, and Bash.

```sh
pi install ~/dotfiles/pi/picosystem/sub-agents
```

In an existing Pi session, run `/reload`. Start Pi inside tmux, then:

```text
/subagent scout Explain how authentication is configured in this project.
/subagents list
/subagents open scout
```

Spawning never changes the parent's focus or layout. Results automatically arrive in the parent as follow-up messages. The agent gets a fresh conversation, not a copy of the parent's context; give it a self-contained task.

## Inspecting and interacting

- `/subagents` — select a task to open using Pi's built-in picker.
- `/subagents open <name>` — open the actual Pi TUI. Pins the worker so it will not auto-exit. A finished worker is reopened with its saved session **without a model request**.
- Switch back using tmux, or run `/subagents parent` inside a worker. Switching away does not stop it.
- `/subagents release <name>` in the parent, or `/subagents release` inside the worker — restore auto-exit once idle.
- `/subagents message <name> <text>` — steer a live worker or resume a finished one asynchronously.
- `/subagents result <name>` — show the last result.
- `/subagents cancel <name>` — request graceful cancellation, then close its pane if it has not exited after five seconds.
- `/subagents agents` — show profiles.

Tmux's window chooser (`prefix + w`) also works, but **does not pin** a worker. Use the `open` command when you need it to stay available. In a worker, `/subagents keep` pins it manually. Killing a tmux window terminates its worker; hiding it means switching away, not closing it.

Normal completion and provider failure auto-exit unless pinned. An interactive Escape/abort keeps the worker open for recovery; release or cancel it when done. Worker `/new`, `/resume`, and `/fork` are blocked so its recorded session identity stays intact.

Workers survive parent quit, reload, and session switches. Their results are delivered when that parent session is resumed. Detached workers still auto-exit on completion; intentionally kept-open workers need to be released/cancelled or quit directly.

## Model-facing tools

| Tool | Purpose |
| --- | --- |
| `subagent({ agent, task, name?, cwd?, model?, keepOpen? })` | Start asynchronously; duplicate names receive numeric suffixes |
| `subagent_message({ name, message })` | Steer or resume the same task/session/loadout |
| `subagents_list({})` | List profiles and configuration warnings |
| `subagents_status({})` | Task status, activity, session/result paths, PID and Linux RSS |
| `subagent_cancel({ name })` | Cancel a live task |

Results are queued as parent follow-ups, rather than interrupting its current turn. Long results are truncated in model context and linked to the full artifact. Worker token/cost usage is included in completion messages; it is separate from the parent's `/session` totals.

## Resource controls

Four live workers per parent session by default. Kept-open and waiting workers count toward the limit. Excess spawns fail clearly rather than starting unlimited processes.

In `~/.pi/agent/settings.json`:

```json
{
  "subagents": {
    "maxConcurrent": 4,
    "agentOverrides": {
      "worker": { "thinking": "high" }
    }
  }
}
```

`maxConcurrent` accepts 1–32 and takes effect on parent reload. `/subagents list` and `subagents_status` show the Pi process's RSS on Linux. This excludes tmux and subprocesses started by tools; it is not total worker-tree memory.

Finished workers are not left running. Sessions and results persist on disk, so follow-ups do not require an idle Pi process. Opening a finished session temporarily starts one until you release it.

## Profiles

Bundled profiles:

- **scout** — `openai-codex/gpt-6.1-sol`, low reasoning; `read`, `grep`, `find`, `ls`; read-only investigation.
- **worker** — `openai-codex/gpt-6.1-sol`, high reasoning; those tools plus `bash`, `edit`, `write`; implementation and testing.
- **researcher** — `openai-codex/gpt-6.1-sol`, medium reasoning; `read`, `web_search`, `web_fetch`; sourced research. Load the web tools in the parent first (e.g. the Firecrawl package).

Profiles are Markdown files in `~/.pi/agent/agents/` or the nearest trusted project's `.pi/agents/`. Priority is **project > global > bundled**. Untrusted project profiles are ignored.

```markdown
---
name: reviewer
description: Focused read-only code review.
tools: [read, grep, find, ls]
thinking: low
keep-open: false
---
Review the delegated change. Cite concrete files and explain actionable issues.
```

Supported fields: `name`, `description`, `tools` (array or comma-separated string), `model`, `thinking`, `cwd`, `keep-open`, and `extensions` (array or comma-separated paths). The body is appended to the system prompt. Model and thinking otherwise inherit from the parent. CWD resolves from the parent's working directory.

`auto-exit: false` is accepted as an alias for `keep-open: true`; `system-prompt: append` and `session-mode: standalone` are also accepted. This is **not** a full compatibility layer for pi-interactive-subagents: nested spawning, copied/lineage contexts, other CLIs, and its supervision-specific fields are not implemented. Clarification can be returned in the final response; the parent replies using `subagent_message`.

Only the extensions backing selected tools are loaded into a child, plus this package's worker controller. Backing extensions are resolved from the parent's tool source metadata. A profile can list additional `extensions`, resolved relative to its Markdown file; use this for a **custom model provider** or tools not loaded in the parent. Resume reuses the original loadout snapshot, not newly edited profile settings. Project resources are only approved automatically when the worker stays in the parent's already-trusted CWD.

**Not an OS sandbox.** Tools and extensions run with your account's permissions. Read-only tool selection is a workflow restriction, not a security boundary. Workers share the working tree: scope edits to disjoint files or provide separate worktree CWDs. Nested subagents are deliberately disabled in this first version.

## Storage and implementation

Artifacts live under:

```text
~/.pi/agent/background-subagents/<parent-session-id>/
  registry.json
  <task-id>/
    system-prompt.md
    mailbox/
    sessions/                 # Pi's normal persisted session
    runs/<run-id>/
      launch.json             # resolved loadout (no environment credentials)
      launch.sh
      control.json
      activity.json
      result.json             # latest completion
      results/                # durable completion outbox
      exit.json
```

The agent-directory override `PI_CODING_AGENT_DIR` is respected. Artifacts are private to the user; transcripts may still contain sensitive data. There is no automatic transcript retention policy. Delete old parent directories manually **after all their workers have exited**.

The window runs its launch script directly, avoiding interactive-shell startup races. Messages travel through a durable file mailbox into `pi.sendUserMessage`, not through simulated terminal keystrokes. Completion uses `agent_settled`, so retries/compaction/queued steering finish before results are reported. A message racing with auto-exit resumes the saved session once the previous worker has exited. Window ownership tags prevent accidental access to reused tmux pane IDs.

## Development

```sh
npm install
npm run typecheck
npm test
```

The tests include real Pi TUI workers on an isolated tmux socket with an offline mock provider: no API calls, charges, or changes to your live tmux layout. They cover async completion, follow-ups, steering, inspection, cancellation, errors, loadout persistence, and parent notification wiring. Pi's host packages are peer dependencies and must be available for development.
