import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents, resolveLoadout } from "./src/agents.ts";
import { childExtension } from "./src/child.ts";
import { Manager } from "./src/manager.ts";
import { CHILD_ENV, capOutput, type Completion, type Job } from "./src/shared.ts";

const extensionPath = fileURLToPath(import.meta.url);
const textResult = (text: string, details: unknown = undefined) => ({ content: [{ type: "text" as const, text }], details });

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
    pi.sendMessage({
      customType: "subagent-result",
      content: `Subagent '${job.name}' (${job.loadout.agent}) ${result.status}.\n\n${capOutput(result.text, artifact)}\n\nSession: ${result.sessionFile ?? "not saved"}\nResult: ${artifact}\nWorker usage: ${result.usage.input} input / ${result.usage.output} output tokens; $${result.usage.cost.toFixed(4)}.`,
      display: true,
      details: { name: job.name, status: result.status, usage: result.usage, resultFile: artifact },
    }, { deliverAs: "followUp", triggerTurn: true });
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
      extensionPath, maxConcurrent: Number(maxConcurrent), onResult: notifyResult,
    });
    sessionId = id;
    timer = setInterval(() => {
      try {
        manager?.refresh();
        const live = [...(manager?.jobs.values() ?? [])].filter((job) => ["starting", "active", "waiting"].includes(job.status));
        ctx.ui.setStatus("subagents", live.length ? `agents ${live.length}/${maxConcurrent} · ${live.map((job) => `${job.name}:${job.status}`).join(" ")}` : undefined);
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
  function spawn(ctx: ExtensionContext, params: { agent: string; task: string; name?: string; cwd?: string; model?: string; keepOpen?: boolean }): Job {
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
    return getManager(ctx).spawn(loadout, params.task, params.name, params.keepOpen ?? agent.keepOpen);
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
    description: "Delegate a task asynchronously to a named agent in an unselected tmux window. Returns immediately; its result arrives as a follow-up message. Use subagents_list for profiles and subagents_status for live tasks. Each worker has independent context but shares the working tree. Do not have concurrent workers edit the same files. No nested spawning.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent profile, e.g. scout, worker, researcher" }),
      task: Type.String({ description: "Complete, self-contained instructions; parent conversation is not copied" }),
      name: Type.Optional(Type.String({ description: "Unique task name; duplicates receive a numeric suffix" })),
      cwd: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
      keepOpen: Type.Optional(Type.Boolean({ description: "Keep the worker TUI alive after completion; defaults to false" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Cancelled before spawn.");
      const job = spawn(ctx, params);
      return textResult(`Started '${job.name}' (${job.loadout.agent}) asynchronously. Result will arrive automatically. Human access: /subagents open ${job.name}`, { name: job.name, agent: job.loadout.agent, paneId: job.paneId });
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
      const profiles = agents.map(({ name, description, tools, model, thinking, source }) => ({ name, description, tools, model: model ?? "parent model", thinking: thinking ?? "parent thinking", source }));
      return textResult(JSON.stringify({ agents: profiles, warnings }, null, 2), { agents: profiles, warnings });
    },
  });
  pi.registerTool({
    name: "subagents_status", label: "Subagent status",
    description: "List delegated tasks and their status, saved sessions, and live Pi process RSS memory on Linux. Does not wait for tasks.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const jobs = getManager(ctx).list();
      return textResult(JSON.stringify(jobs, null, 2), { jobs });
    },
  });
  pi.registerTool({
    name: "subagent_cancel", label: "Cancel subagent",
    description: "Cancel a live worker gracefully; force-close its tmux pane if it does not exit. Saved conversation and completed results remain available.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      await getManager(ctx).cancel(params.name);
      return textResult(`Cancelled '${params.name}'.`, { name: params.name });
    },
  });

  pi.registerCommand("subagent", {
    description: "Delegate directly: /subagent <profile> <task>",
    handler: async (args, ctx) => {
      try {
        const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
        if (!match) throw new Error("Usage: /subagent <profile> <task>");
        const job = spawn(ctx, { agent: match[1], task: match[2] });
        ctx.ui.notify(`Started ${job.name}. /subagents open ${job.name}`, "info");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.registerCommand("subagents", {
    description: "Manage workers: list, agents, open <name>, message <name> <text>, release <name>, cancel <name>, result <name>",
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
          const options = jobs.map((job) => `${job.name} · ${job.status}${job.rssMiB ? ` · ${job.rssMiB} MiB` : ""}`);
          const selected = await ctx.ui.select("Open subagent (keeps it alive)", options);
          if (selected) await m.open(String(jobs[options.indexOf(selected)].name));
        } else if (action === "list") {
          const jobs = m.list();
          ctx.ui.notify(jobs.map((j) => `${j.name} · ${j.status}${j.activity ? ` · ${j.activity}` : ""}${j.rssMiB ? ` · ${j.rssMiB} MiB` : ""}${j.keepOpen ? " · kept open" : ""}`).join("\n") || "No subagents.", "info");
        } else if (!name) throw new Error(`Usage: /subagents ${action} <name>`);
        else if (action === "open") await m.open(name);
        else if (action === "release") { m.release(name); ctx.ui.notify(`${name} will exit when idle.`, "info"); }
        else if (action === "cancel") { await m.cancel(name); ctx.ui.notify(`Cancelled ${name}.`, "info"); }
        else if (action === "message") {
          const message = args.trim().replace(/^\S+\s+\S+\s*/, "");
          if (!rest.length) throw new Error("Usage: /subagents message <name> <text>");
          m.message(name, message);
          ctx.ui.notify(`Message queued for ${name}.`, "info");
        } else if (action === "result") {
          m.refresh();
          const job = m.get(name);
          ctx.ui.notify(job.result ? capOutput(job.result.text, job.resultFile ?? join(job.run, "result.json"), 8000) : "No result yet.", "info");
        } else throw new Error("/subagents list | agents | open <name> | message <name> <text> | release <name> | cancel <name> | result <name>");
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
}
