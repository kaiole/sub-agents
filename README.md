# Background subagents for Pi

Async workers in **unselected tmux windows**, not splits or new tmux sessions. Each worker runs the normal Pi TUI, so inspecting or steering it does not require a separate interface.

## Install and try

Tested with Pi 1.0.2 and tmux 3.7c. Requires the `agent_settled` extension lifecycle, tmux with `new-window -e`, and Bash. Isolated editing additionally requires Git with `merge-tree --write-tree` support (Git 2.38+) and a repository with an existing commit.

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
- `/subagents diff <name>` — review a stopped worker's changes against its launch baseline; save a full patch artifact.
- `/subagents integrate <name>` — explicitly integrate into the original parent checkout, then remove the worktree/private refs.
- `/subagents discard <name>` — explicitly delete the stopped worker's checkout and unfinished work, retaining its conversation/results.

Tmux's window chooser (`prefix + w`) also works, but **does not pin** a worker. Use the `open` command when you need it to stay available. In a worker, `/subagents keep` pins it manually. Killing a tmux window terminates its worker; hiding it means switching away, not closing it.

Normal completion and provider failure auto-exit unless pinned. An interactive Escape/abort keeps the worker open for recovery; release or cancel it when done. Worker `/new`, `/resume`, and `/fork` are blocked so its recorded session identity stays intact.

Workers survive parent quit, reload, and session switches. Their results are delivered when that parent session is resumed. Detached workers still auto-exit on completion; intentionally kept-open workers need to be released/cancelled or quit directly.

## Model-facing tools

| Tool | Purpose |
| --- | --- |
| `subagent({ agent, task, name?, cwd?, model?, keepOpen?, isolation?, baseline? })` | Start asynchronously; duplicate names receive numeric suffixes |
| `subagent_message({ name, message })` | Steer or resume the same task/session/loadout |
| `subagents_list({})` | List profiles and configuration warnings |
| `subagents_status({})` | Task status, questions/waiting reasons, run/activity durations, heartbeat health, session/result paths, PID and Linux RSS |
| `subagent_cancel({ name })` | Cancel execution; retain isolated work |
| `subagent_diff({ name })` | Review the stopped worker's delta against its fixed baseline |
| `subagent_integrate({ name })` | Explicitly integrate, preserving parent edits and staging; finalize and clean up |
| `subagent_discard({ name })` | Explicitly delete retained isolated work; finalize and clean up |

Results are queued as parent follow-ups, rather than interrupting its current turn. Long results are truncated in model context and linked to the full artifact. Worker token/cost usage is included in completion messages; it is separate from the parent's `/session` totals.

## Isolated editing worktrees

Editing-capable workers use a separate Git worktree and task branch by default. Known read-only tools (`read`, `grep`, `find`, `ls`, web/PDF readers, `ask_question`) default to sharing the parent checkout. Unknown/custom tools are conservatively treated as editing-capable. This default is not a security classification; explicitly override it when appropriate.

Per delegation:

- **`baseline: "head"`** (default): start from the last commit in the selected CWD's repository, excluding unfinished parent changes.
- **`baseline: "current"`**: take a private, fixed snapshot of staged and unstaged tracked changes plus non-ignored untracked files. The parent checkout, branch and staging area are untouched. This internal commit is not added to the parent's branch history.
- **`isolation: "shared"`**: explicitly opt out of isolation. Do not also specify a baseline. Useful outside Git or when the task genuinely requires shared files.
- **`isolation: "worktree"`**: explicitly isolate even a read-only worker. Specifying a baseline also implies isolation unless explicitly contradicted by `shared`.

```text
/subagent --baseline current worker Finish the validation logic using my unfinished changes.
/subagent --baseline head worker Implement the unrelated logging improvement.
/subagent --isolation shared worker Update files outside a Git repository.
```

Flags precede the profile; everything after the profile is literal task text. Tool example:

```typescript
subagent({ agent: "worker", task: "Finish the validation logic.", baseline: "current" })
```

Isolation failures are errors, **never silent fallback to a shared directory**. Worker CWD keeps the original repository-relative subdirectory (creating an empty directory if it is absent from the baseline); symlinked CWD mappings are refused. Follow-ups, clarification answers and inspection reuse the same checkout and baseline, including after parent reload. The new checkout does not automatically inherit project-resource approval.

### Review and integration

Completion only reports a result: it **never modifies the parent checkout**. Release a pinned worker and wait for exit (or cancel it) before reviewing, integrating or discarding. Queued messages must also be resolved or cancelled.

```text
/subagents diff worker
/subagents message worker Please revise the error handling.
# After the revised worker exits:
/subagents integrate worker
```

Review includes committed and uncommitted worker changes, relative to the snapshot—not `HEAD`. The full binary patch is saved as `<task-dir>/worker.patch`, including after integration.

Integration three-way merges the worker's delta with the parent's **current** state. It does not require a clean checkout or stash away unfinished work. Compatible parent changes are preserved. Conflicts refuse integration without writing conflict markers or changing parent files/index; the worker checkout remains available for revisions. Existing staged changes stay staged; worker changes are initially unstaged. Integration does not merge the snapshot commit into the parent's history. Direct integration tool calls serialize their tool batch, and the human integration command waits for the parent to become idle. Do not edit either checkout from external editors/processes during integration; Git locks cannot prevent non-Git filesystem writes.

### Retention and cleanup

Completed, failed and cancelled workers retain their checkout and partial work until explicit integration or discard. **Cancel stops execution; discard deletes work.** Successful integration automatically removes the task worktree and private refs. Saved sessions, results and review artifacts persist.

Finalized tasks cannot resume or reopen a worker in the deleted checkout; use their saved session/result artifacts for inspection, and start a new task for further edits. If cleanup fails after integration, status reports the pending cleanup. Retry integration to retry cleanup **without reapplying changes**; discard cleanup can likewise be retried. There is no time-based deletion.

### Boundaries

Ignored dependencies/build outputs are not copied; workers may need their own dependency setup. Snapshotting a repository can include sensitive non-ignored files: use `.gitignore` appropriately. Task branches are local branches under `pi-subagents/`; do not publish them. Commands such as `git push --all` or `--mirror` can publish unfinished snapshots while those refs exist. Worktrees share Git object storage, refs, stash and repository-level configuration. Workers are instructed not to alter other checkouts/branches, use the shared stash, change repository-wide configuration, or push task branches/private refs.

This is **file isolation, not an OS sandbox**. External databases, services, ports and caches remain shared; workers should report shared-resource needs to the parent. There is no resource allocator or external lock mechanism in this version.

For safety, this version refuses repositories with submodules, sparse/skip-worktree or assume-unchanged indexes, unmerged/in-progress Git operations, custom clean/smudge filters or merge drivers, `core.autocrlf` transformations, `core.symlinks=false`, content-transforming Git attributes such as `text`, `eol`, and `working-tree-encoding`, or non-UTF-8 Git filenames. Use explicit sharing only if that workflow is acceptable. Private snapshot objects may remain in Git's object store until normal garbage collection, even after their refs are removed.

## Clarification requests

Every worker has an `ask_question({ question })` tool, in addition to its profile's tools. When requirements are missing or a material decision blocks the task, the worker can ask instead of guessing. It calls this tool **alone**, ending its turn without an extra model request.

The question is saved as a durable `needs-input` result and sent to the parent as a follow-up, explicitly distinguished from task completion. The worker normally exits, freeing its concurrency slot while it waits. Explicitly kept-open/pinned workers remain available until released. Reply using the same task name:

```text
/subagents message worker Use SQLite; no external database service.
```

Or call `subagent_message({ name: "worker", message: "Use SQLite." })`. This resumes the same conversation and snapshotted loadout. Questions survive parent reload/quit, can be inspected with `/subagents list` or `/subagents result <name>`, and can be cancelled without starting a worker. An answer arriving during shutdown is preserved by the mailbox and resumed after the old process exits.

## Activity and health

The picker and `/subagents list` show elapsed time for the current/latest run, the current activity's duration, and an explicit waiting reason: human input, clarification, session inspection, or release of a finished kept-open worker. Elapsed time freezes when a run exits; a follow-up starts a new run timer. `subagents_status` exposes these durations in milliseconds, plus `live`, `health`, `heartbeatAgeMs`, `waitingFor`, and any pending `question`.

A live worker with no fresh valid heartbeat for **60 seconds** is marked `stalled`; the parent receives one follow-up on that transition and another on recovery. This indicates missing monitoring/liveness evidence, not proof the task failed. A slow model request or long-running tool remains healthy while its heartbeat continues. Exited workers—including process-free clarification waits—do not generate stall alerts.

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
# Optional: names of skills already enabled in the parent
# skills: [code-review]
thinking: low
keep-open: false
---
Review the delegated change. Cite concrete files and explain actionable issues.
```

Supported fields: `name`, `description`, `tools` (array or comma-separated string), `skills` (array or comma-separated names), `model`, `thinking`, `cwd`, `keep-open`, and `extensions` (array or comma-separated paths). The body is appended to the system prompt. Model and thinking otherwise inherit from the parent. CWD resolves from the parent's working directory.

`skills: [pdf-reading, research-methods]` preloads those skills into the worker's **initial system prompt**, without issuing skill-loading model turns. Names resolve against the parent's enabled skill resources, including package/custom locations and explicitly invoked-only skills. Missing/unreadable skills fail before spawning; untrusted project skills are not accepted. The skill body and source path are snapshotted with the loadout, so later follow-ups retain the original instructions even if the skill file changes or disappears. Relative references resolve from the original skill's directory, not the worker CWD. Supporting files/scripts themselves are not copied or frozen.

`auto-exit: false` is accepted as an alias for `keep-open: true`; `system-prompt: append` and `session-mode: standalone` are also accepted. This is **not** a full compatibility layer for pi-interactive-subagents: nested spawning, copied/lineage contexts, other CLIs, and its supervision-specific profile fields are not implemented. Use `ask_question` for structured clarification; the parent replies using `subagent_message`.

Only the extensions backing selected tools are loaded into a child, plus this package's worker controller. Backing extensions are resolved from the parent's tool source metadata. A profile can list additional `extensions`, resolved relative to its Markdown file; use this for a **custom model provider** or tools not loaded in the parent. Resume reuses the original loadout snapshot, not newly edited profile settings. Project resources are only approved automatically when the worker stays in the parent's already-trusted CWD.

**Not an OS sandbox.** Tools and extensions run with your account's permissions. Read-only tool selection is a workflow restriction, not a security boundary. Editing workers normally have isolated worktrees; explicitly shared checkouts still need coordinated edits. Nested subagents are deliberately disabled in this first version.

## Storage and implementation

Artifacts live under:

```text
~/.pi/agent/background-subagents/<parent-session-id>/
  registry.json
  <task-id>/
    system-prompt.md
    worktree/                 # isolated checkout, until integrated/discarded
    worktree-owner.json       # private ownership/cleanup record
    worker.patch              # full reviewed delta, when requested/integrated
    mailbox/
    sessions/                 # Pi's normal persisted session
    runs/<run-id>/
      launch.json             # resolved loadout (no environment credentials)
      launch.sh
      control.json
      activity.json           # heartbeat, activity age, waiting reason
      question.json           # pending clarification, when present
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

The tests include real Pi TUI workers on an isolated tmux socket with an offline mock provider: no API calls, charges, or changes to your live tmux layout. They cover async completion, clarification/answer round trips without extra model turns, preloaded skill startup/resume, follow-ups, steering, inspection, cancellation, errors, loadout persistence, real isolated writes/integration, and parent notification/tool wiring. Real-Git unit tests cover snapshots, dirty-checkout integration, conflict refusal, index preservation and worktree lifecycle. Deterministic unit tests cover skill discovery/trust/snapshots, activity timing, and heartbeat stall/recovery transitions. Pi's host packages are peer dependencies and must be available for development.
