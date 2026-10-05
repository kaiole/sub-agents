import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents, resolveLoadout } from "./src/agents.ts";
import { childExtension } from "./src/child.ts";
import { Manager, type WorktreeResult } from "./src/manager.ts";
import { formatDuration } from "./src/health.ts";
import { CHILD_ENV, capOutput, type Completion, type Job, type SpawnOptions } from "./src/shared.ts";

const extensionPath = fileURLToPath(import.meta.url);
const textResult = (text: string, details: unknown = undefined) => ({ content: [{ type: "text" as const, text }], details });

export function parseDelegation(args: string): { agent: string; task: string } & SpawnOptions {
  let rest = args.trim();
  const options: SpawnOptions = {};
  while (rest.startsWith("--")) {
    const flag = rest.match(/^--(baseline|isolation)\s+(\S+)\s+([\s\S]+)$/);
    if (!flag) throw new Error("Usage: /subagent [--baseline head|current] [--isolation worktree|shared] <profile> <task>");
    if (flag[1] === "baseline") {
      if (options.baseline || !["head", "current"].includes(flag[2])) throw new Error("Specify --baseline head|current once.");
      options.baseline = flag[2] as SpawnOptions["baseline"];
    } else {
      if (options.isolation || !["worktree", "shared"].includes(flag[2])) throw new Error("Specify --isolation worktree|shared once.");
      options.isolation = flag[2] as SpawnOptions["isolation"];
    }
    rest = flag[3].trim();
  }
  const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
  if (!match) throw new Error("Usage: /subagent [--baseline head|current] [--isolation worktree|shared] <profile> <task>");
  return { ...options, agent: match[1], task: match[2] };
}

function worktreeResultText(name: string, result: WorktreeResult): string {
  const outcome = result.state === "integrated"
    ? `Integrated '${name}' into ${result.parentRoot}. Worker changes are unstaged; existing staging is preserved.`
    : `Discarded '${name}'. Parent files were not changed.`;
  return `${outcome}\n${result.cleanupError
    ? `Cleanup pending: ${result.cleanupError}. Retry subagent_${result.state === "integrated" ? "integrate" : "discard"} to retry cleanup without reapplying changes.`
    : "Task worktree and private refs removed. Saved conversation/results remain available."}`;
}

export default function (pi: ExtensionAPI): void {
  const childRun = process.env[CHILD_ENV];
  if (childRun) {
    childExtension(pi, childRun);
    return;
  }

  let manager: Manager | undefined;
  let sessionId: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastPollError: string | undefined;

  function stopMonitoring(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
    manager = undefined;
    sessionId = undefined;
  }

  function notifyResult(job: Job, result: Completion): void {
    const artifact = job.resultFile ?? join(job.run, "result.json");
    const replyHint = result.status === "needs-input"
      ? `\n\nThis is a clarification request, not task completion. Reply with subagent_message({ name: "${job.name}", message: "your answer" }) to resume the saved conversation.` : "";
    const worktreeHint = job.worktree
      ? `\n\nIsolated checkout: ${job.worktree.path}\nBaseline: ${job.worktree.baseline} (${job.worktree.baselineCommit}). Parent files are unchanged. After the worker exits, use subagent_diff to review, then explicitly subagent_integrate or subagent_discard. Use subagent_message for revisions before finalizing.` : "";
    pi.sendMessage({
      customType: "subagent-result",
      content: `Subagent '${job.name}' (${job.loadout.agent}) ${result.status}.\n\n${capOutput(result.question ?? result.text, artifact)}${replyHint}${worktreeHint}\n\nSession: ${result.sessionFile ?? "not saved"}\nResult: ${artifact}\nWorker usage: ${result.usage.input} input / ${result.usage.output} output tokens; $${result.usage.cost.toFixed(4)}.`,
      display: true,
      details: { name: job.name, status: result.status, question: result.question, usage: result.usage, resultFile: artifact, worktree: job.worktree },
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  function notifyHealth(job: Job, transition: "stalled" | "recovered"): void {
    pi.sendMessage({
      customType: "subagent-health", display: true,
      content: transition === "stalled"
        ? `Subagent '${job.name}' has a stale or missing heartbeat. Its process is still present, but monitoring cannot confirm it is responsive. Inspect it with /subagents open ${job.name}, or use subagents_status/subagent_cancel. This is not a timeout on a long-running tool or model request.`
        : `Subagent '${job.name}' recovered: its heartbeat is fresh again.`,
      details: { name: job.name, transition },
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  function jobLabel(job: Record<string, unknown>): string {
    const worktree = job.worktree as Job["worktree"];
    return `${job.name} · ${job.status}${job.health === "stalled" ? " · stale heartbeat" : ""} · ${formatDuration(Number(job.elapsedMs ?? 0))}` +
      `${job.waitingFor ? ` · waiting: ${job.waitingFor}` : ""}` +
      `${job.activity ? ` · ${job.activity} ${formatDuration(Number(job.activityDurationMs ?? 0))}` : ""}` +
      `${job.rssMiB ? ` · ${job.rssMiB} MiB` : ""}${job.keepOpen ? " · kept open" : ""}` +
      `${worktree ? ` · worktree:${worktree.baseline}/${worktree.state}` : " · shared"}`;
  }

  function getManager(ctx: ExtensionContext): Manager {
    const id = ctx.sessionManager.getSessionId();
    if (manager && sessionId === id) return manager;
    stopMonitoring();
    const settings = pi.getSettings() as unknown as { subagents?: { maxConcurrent?: unknown } };
    const maxConcurrent = settings.subagents?.maxConcurrent ?? 4;
    if (!Number.isSafeInteger(maxConcurrent) || Number(maxConcurrent) < 1 || Number(maxConcurrent) > 32) {
      throw new Error("subagents.maxConcurrent must be an integer between 1 and 32.");
    }
    if (!process.env.TMUX || !process.env.TMUX_PANE) throw new Error("Start Pi inside tmux to use subagents.");
    manager = new Manager({
      directory: join(getAgentDir(), "background-subagents", id),
      parentPane: process.env.TMUX_PANE,
      extensionPath, maxConcurrent: Number(maxConcurrent), onResult: notifyResult, onHealth: notifyHealth,
    });
    sessionId = id;
    timer = setInterval(() => {
      try {
        const jobs = manager?.list() ?? [];
        const live = jobs.filter((job) => job.live);
        const questions = jobs.filter((job) => job.status === "needs-input");
        const visible = jobs.filter((job) => job.live || job.status === "needs-input");
        ctx.ui.setStatus("subagents", visible.length ? `agents ${live.length}/${maxConcurrent}${questions.length ? ` · ${questions.length} need input` : ""} · ${visible.map((job) => `${job.name}:${job.health === "stalled" ? "stalled" : job.status}`).join(" ")}` : undefined);
        lastPollError = undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastPollError) ctx.ui.notify(`Subagent monitoring: ${message}`, "warning");
        lastPollError = message;
      }
    }, 1000);
    return manager;
  }

  function definitions(ctx: ExtensionContext) { return discoverAgents(ctx.cwd, ctx.isProjectTrusted()); }
  function spawn(ctx: ExtensionContext, params: { agent: string; task: string; name?: string; cwd?: string; model?: string; keepOpen?: boolean } & SpawnOptions): Job {
    const { agents, warnings } = definitions(ctx);
    const agent = agents.find((agent) => agent.name === params.agent);
    if (!agent) throw new Error(`Unknown agent '${params.agent}'. Available: ${agents.map((agent) => agent.name).join(", ")}.\n${warnings.join("\n")}`);
    const loadout = resolveLoadout(agent, pi, ctx, params.cwd, params.model);
    // Preserve existing per-agent overrides in the user's settings.
    const settings = pi.getSettings() as unknown as { subagents?: { agentOverrides?: Record<string, { thinking?: string }> } };
    const thinking = settings.subagents?.agentOverrides?.[agent.name]?.thinking;
    if (thinking) {
      if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) throw new Error(`Invalid thinking override for ${agent.name}: ${thinking}`);
      loadout.thinking = thinking as typeof loadout.thinking;
    }
    return getManager(ctx).spawn(loadout, params.task, params.name, params.keepOpen ?? agent.keepOpen, { isolation: params.isolation, baseline: params.baseline });
  }

  pi.on("session_start", (_event, ctx) => {
    // No tmux dependency until a worker is requested, unless restoring an existing registry.
    stopMonitoring();
    if (process.env.TMUX && process.env.TMUX_PANE) {
      try { getManager(ctx); }
      catch (error) { ctx.ui.notify(`Subagents: ${error instanceof Error ? error.message : error}`, "warning"); }
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    stopMonitoring();
    ctx.ui.setStatus("subagents", undefined);
    // Workers intentionally survive parent quit/reload. Their registry is reconciled on resume.
  });

  pi.registerTool({
    name: "subagent", label: "Subagent",
    description: "Delegate asynchronously in an unselected tmux window. Editing-capable workers get isolated Git worktrees by default; read-only workers share the checkout. Choose baseline head (default, committed code) or current (fixed snapshot of unfinished work). Results never auto-integrate: review with subagent_diff, explicitly integrate or discard after exit. isolation shared explicitly opts out. Isolation failures never fall back to sharing. External resources remain shared. No nested spawning.",
    executionMode: "sequential",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent profile, e.g. scout, worker, researcher" }),
      task: Type.String({ description: "Complete, self-contained instructions; parent conversation is not copied" }),
      name: Type.Optional(Type.String({ description: "Unique task name; duplicates receive a numeric suffix" })),
      cwd: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
      isolation: Type.Optional(Type.Union([Type.Literal("worktree"), Type.Literal("shared")], { description: "Defaults to worktree for editing-capable tools, shared for read-only tools. No silent fallback." })),
      baseline: Type.Optional(Type.Union([Type.Literal("head"), Type.Literal("current")], { description: "head: committed code (default). current: tracked edits and nonignored untracked files at launch. Implies worktree isolation; incompatible with shared." })),
      keepOpen: Type.Optional(Type.Boolean({ description: "Keep the worker TUI alive after completion; defaults to false" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Cancelled before spawn.");
      const job = spawn(ctx, params);
      return textResult(`Started '${job.name}' (${job.loadout.agent}) asynchronously. ${job.worktree ? `Isolated checkout: ${job.worktree.path}; baseline: ${job.worktree.baseline}. Integration is explicit.` : "Shared checkout."} Result will arrive automatically. Human access: /subagents open ${job.name}`, { name: job.name, agent: job.loadout.agent, paneId: job.paneId, cwd: job.loadout.cwd, worktree: job.worktree });
    },
  });
  pi.registerTool({
    name: "subagent_message", label: "Message subagent",
    description: "Send a message by task name. Steers a live agent without typing into its editor, or resumes its saved session if finished. Returns immediately; completion arrives automatically.",
    parameters: Type.Object({ name: Type.String(), message: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      const job = getManager(ctx).message(params.name, params.message);
      return textResult(`Message queued for '${job.name}'.`, { name: job.name });
    },
  });
  pi.registerTool({
    name: "subagents_list", label: "Agent profiles",
    description: "List available agent profiles (bundled < global < trusted project overrides).",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const { agents, warnings } = definitions(ctx);
      const profiles = agents.map(({ name, description, tools, skills, model, thinking, source }) => ({ name, description, tools, skills, model: model ?? "parent model", thinking: thinking ?? "parent thinking", source }));
      return textResult(JSON.stringify({ agents: profiles, warnings }, null, 2), { agents: profiles, warnings });
    },
  });
  pi.registerTool({
    name: "subagents_status", label: "Subagent status",
    description: "List delegated tasks, worktree/baseline/finalization state, clarification questions, waiting reasons, runtime/activity durations, heartbeat health, saved sessions, and live Pi process RSS on Linux. Does not wait for tasks.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const jobs = getManager(ctx).list();
      return textResult(JSON.stringify(jobs, null, 2), { jobs });
    },
  });
  pi.registerTool({
    name: "subagent_cancel", label: "Cancel subagent",
    description: "Cancel a live worker gracefully; force-close its tmux pane if it does not exit. Retains its worktree, partial work, saved conversation and results. Use subagent_discard separately to delete isolated work.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      await getManager(ctx).cancel(params.name);
      return textResult(`Cancelled '${params.name}'.`, { name: params.name });
    },
  });

  pi.registerTool({
    name: "subagent_diff", label: "Review subagent changes",
    description: "Review an exited worker's complete delta against its launch baseline, including committed and uncommitted edits. Saves a full binary patch artifact; output is bounded. Does not modify the parent checkout. Worker must be stopped and its worktree retained.",
    executionMode: "sequential",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      const { patch, file } = getManager(ctx).diff(params.name);
      return textResult(capOutput(patch || "No worker changes.", file), { name: params.name, patchFile: file });
    },
  });
  pi.registerTool({
    name: "subagent_integrate", label: "Integrate subagent changes",
    description: "Explicitly integrate an exited worker's delta into its original parent checkout, even when dirty. Three-way conflicts refuse without modifying parent files/index. Preserves existing staging; worker changes are unstaged. On success closes the task and removes its worktree/private refs. Cannot resume a finalized task. Retrying a finalized integration only retries cleanup.",
    executionMode: "sequential",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params, signal, _update, ctx) {
      const m = getManager(ctx);
      const root = m.get(params.name).worktree?.parentRoot ?? ctx.cwd;
      const result = await withFileMutationQueue(root, async () => {
        if (signal?.aborted) throw new Error("Cancelled before integration.");
        return m.integrate(params.name);
      });
      return textResult(worktreeResultText(params.name, result), { name: params.name, ...result });
    },
  });
  pi.registerTool({
    name: "subagent_discard", label: "Discard subagent worktree",
    description: "Explicitly delete an exited worker's retained isolated work, worktree and private refs. Cancellation alone does not delete work. Parent files are untouched; saved conversation/results persist. Finalized tasks cannot be resumed.",
    executionMode: "sequential",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Cancelled before discard.");
      const result = getManager(ctx).discard(params.name);
      return textResult(worktreeResultText(params.name, result), { name: params.name, ...result });
    },
  });

  pi.registerCommand("subagent", {
    description: "Delegate: /subagent [--baseline head|current] [--isolation worktree|shared] <profile> <task>",
    handler: async (args, ctx) => {
      try {
        const job = spawn(ctx, parseDelegation(args));
        ctx.ui.notify(`Started ${job.name} (${job.worktree ? `worktree, ${job.worktree.baseline} baseline` : "shared checkout"}). /subagents open ${job.name}`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.registerCommand("subagents", {
    description: "Manage workers: list, agents, open, message, release, cancel, result, diff, integrate, discard",
    handler: async (args, ctx) => {
      try {
        const [action, name, ...rest] = args.trim().split(/\s+/);
        if (action === "agents") {
          const { agents, warnings } = definitions(ctx);
          ctx.ui.notify([...agents.map((a) => `${a.name}: ${a.description}`), ...warnings].join("\n"), "info");
          return;
        }
        const m = getManager(ctx);
        if (!action) {
          const jobs = m.list();
          if (!jobs.length) { ctx.ui.notify("No subagents yet. /subagent scout <task>", "info"); return; }
          const options = jobs.map(jobLabel);
          const selected = await ctx.ui.select("Open subagent (keeps it alive)", options);
          if (selected) await m.open(String(jobs[options.indexOf(selected)].name));
        } else if (action === "list") {
          const jobs = m.list();
          ctx.ui.notify(jobs.map((job) => `${jobLabel(job)}${job.question ? `\n  Question: ${job.question}` : ""}`).join("\n") || "No subagents.", "info");
        } else if (!name) throw new Error(`Usage: /subagents ${action} <name>`);
        else if (action === "open") await m.open(name);
        else if (action === "release") { m.release(name); ctx.ui.notify(`${name} will exit when idle.`, "info"); }
        else if (action === "cancel") { await m.cancel(name); ctx.ui.notify(`Cancelled ${name}.`, "info"); }
        else if (action === "message") {
          const message = args.trim().replace(/^\S+\s+\S+\s*/, "");
          if (!rest.length) throw new Error("Usage: /subagents message <name> <text>");
          m.message(name, message);
          ctx.ui.notify(`Message queued for ${name}.`, "info");
        } else if (action === "diff") {
          const { patch, file } = m.diff(name);
          ctx.ui.notify(`${capOutput(patch || "No worker changes.", file, 8000)}\nPatch: ${file}`, "info");
        } else if (action === "integrate") {
          // A human command can arrive while the parent's tools are still writing.
          // Unlike model tools, command handlers are not covered by executionMode.
          await ctx.waitForIdle();
          const root = m.get(name).worktree?.parentRoot ?? ctx.cwd;
          const result = await withFileMutationQueue(root, async () => m.integrate(name));
          ctx.ui.notify(worktreeResultText(name, result), result.cleanupError ? "warning" : "info");
        } else if (action === "discard") {
          if (ctx.hasUI && !await ctx.ui.confirm(`Discard ${name}?`, "Delete this worker's isolated checkout and unfinished work? Saved conversation/results remain.")) return;
          const result = m.discard(name);
          ctx.ui.notify(worktreeResultText(name, result), result.cleanupError ? "warning" : "info");
        } else if (action === "result") {
          m.refresh();
          const job = m.get(name);
          ctx.ui.notify(job.result ? capOutput(job.result.text, job.resultFile ?? join(job.run, "result.json"), 8000) : "No result yet.", "info");
        } else throw new Error("/subagents list | agents | open <name> | message <name> <text> | release <name> | cancel <name> | result <name> | diff <name> | integrate <name> | discard <name>");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
}
