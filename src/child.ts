import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { readJson, writeJson, type Activity, type Completion, type Control, type Launch, type Mail } from "./shared.ts";
import { Tmux } from "./tmux.ts";

/** Runs inside the worker's actual interactive Pi process. No stdin/send-keys automation. */
export function childExtension(pi: ExtensionAPI, run: string): void {
  const launch = readJson<Launch>(join(run, "launch.json"));
  if (!launch) throw new Error(`Missing launch snapshot: ${run}`);
  let ctx: ExtensionContext;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closing = false;
  let idle = launch.inspection || readJson<Activity>(join(run, "activity.json"))?.status === "waiting";
  let lastAssistant: AssistantMessage | undefined;
  let outcome: "completed" | "error" | "aborted" = "completed";
  let status: Activity["status"] = "starting";
  let detail = "loading";
  let lastHeartbeat = 0;
  let lastKeepOpen: boolean | undefined;
  let usage: Completion["usage"] = emptyUsage();
  const outbox = join(run, "results");
  let completionSequence = existsSync(outbox) ? readdirSync(outbox).length : 0;

  function emptyUsage(): Completion["usage"] { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }; }
  function control(): Control { return readJson<Control>(join(run, "control.json")) ?? { keepOpen: false }; }
  function heartbeat(): void {
    lastHeartbeat = Date.now();
    lastKeepOpen = control().keepOpen;
    writeJson(join(run, "activity.json"), {
      status, detail, pid: process.pid, sessionFile: ctx.sessionManager.getSessionFile(), updatedAt: lastHeartbeat, keepOpen: lastKeepOpen,
    } satisfies Activity);
    ctx.ui.setStatus("subagent", `${launch!.name} · ${lastKeepOpen ? "kept open" : "auto-exit"}`);
  }
  function activity(next: Activity["status"], text: string): void {
    status = next;
    detail = text;
    heartbeat();
  }
  function complete(resultStatus: Completion["status"], text: string): void {
    const result: Completion = {
      id: randomUUID(), status: resultStatus, text, usage,
      sessionFile: ctx.sessionManager.getSessionFile(), completedAt: Date.now(),
    };
    // An outbox preserves every completion even if multiple fast turns settle between parent polls.
    writeJson(join(outbox, `${String(completionSequence++).padStart(8, "0")}-${result.id}.json`), result);
    writeJson(join(run, "result.json"), result);
  }
  function stop(): void {
    if (closing) return;
    closing = true;
    if (timer) clearInterval(timer);
    ctx.shutdown();
  }
  function drainMailbox(): void {
    const files = readdirSync(launch!.mailbox).filter((name) => name.endsWith(".json")).sort();
    for (const name of files) {
      const file = join(launch!.mailbox, name);
      const mail = readJson<Mail>(file);
      if (!mail || typeof mail.message !== "string" || !mail.message.trim()) throw new Error(`Invalid mailbox message: ${file}`);
      // sendUserMessage always triggers a turn when idle and queues steering while busy.
      pi.sendUserMessage(mail.message, { deliverAs: "steer", expandPromptTemplates: false });
      unlinkSync(file);
      idle = false;
    }
  }
  function tick(): void {
    if (closing) return;
    try {
      const current = control();
      if (current.cancel) {
        complete("cancelled", "Cancelled by the parent.");
        ctx.abort();
        stop();
        return;
      }
      drainMailbox();
      if (idle && ctx.isIdle() && !ctx.hasPendingMessages() && !current.keepOpen) {
        stop();
        return;
      }
      if (current.keepOpen !== lastKeepOpen || Date.now() - lastHeartbeat > 5000) heartbeat();
    } catch (error) {
      complete("error", `Worker control failed: ${error instanceof Error ? error.message : error}`);
      ctx.abort();
      stop();
    }
  }

  pi.on("session_start", (_event, context) => {
    ctx = context;
    closing = false;
    const missing = launch.loadout.tools.filter((name) => !pi.getAllTools().some((tool) => tool.name === name && tool.exposure !== "hidden"));
    if (ctx.mode !== "tui" || missing.length) {
      complete("error", missing.length ? `Missing worker tools: ${missing.join(", ")}` : "Workers must run in interactive Pi mode.");
      stop();
      return;
    }
    pi.setActiveTools(launch.loadout.tools);
    activity(launch.inspection ? "waiting" : "starting", launch.inspection ? "inspection" : "ready");
    timer = setInterval(tick, 250);
  });
  pi.on("before_agent_start", () => { pi.setActiveTools(launch.loadout.tools); });
  // Session replacement would disconnect the worker from its recorded identity and mailbox.
  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));
  pi.on("cache_warming_decision", () => ({ action: "stop" }));
  pi.on("agent_start", () => {
    idle = false;
    lastAssistant = undefined;
    usage = emptyUsage();
    outcome = "completed";
    activity("active", "model");
  });
  pi.on("tool_execution_start", (event) => { activity("active", event.toolName); });
  pi.on("tool_execution_end", () => { activity("active", "model"); });
  pi.on("ui_prompt_start", (event) => { activity("waiting", event.title ?? event.kind); });
  pi.on("ui_prompt_end", () => { activity("active", "model"); });
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role === "assistant") lastAssistant = message;
    if ((message.role === "assistant" || message.role === "toolResult") && message.usage) {
      usage.input += message.usage.input;
      usage.output += message.usage.output;
      usage.cacheRead += message.usage.cacheRead;
      usage.cacheWrite += message.usage.cacheWrite;
      usage.cost += message.usage.cost.total;
    }
  });
  pi.on("agent_before_settle", (event) => { outcome = event.outcome; });
  pi.on("agent_settled", () => {
    if (closing) return;
    const text = lastAssistant?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
    const resultStatus = outcome === "aborted" ? "cancelled" : outcome === "error" ? "error" : "done";
    complete(resultStatus, lastAssistant?.errorMessage || text || (resultStatus === "done" ? "(No final text.)" : `Worker ${resultStatus}.`));
    idle = true;
    activity("waiting", resultStatus === "done" ? "finished" : resultStatus);
    // After an interactive Escape/abort, leave the live TUI available for recovery.
    if (resultStatus === "cancelled") writeJson(join(run, "control.json"), { keepOpen: true });
    // Do not shut down synchronously in the settlement callback. Drain any racing messages first.
  });
  pi.on("session_shutdown", (event) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (!closing && !idle && event.reason !== "reload") complete("cancelled", "Worker exited before completing its task.");
    closing = true;
  });

  pi.registerCommand("subagents", {
    description: "Worker controls: keep, release, parent",
    handler: async (args, context) => {
      ctx = context;
      const action = args.trim();
      if (action === "keep" || action === "release") {
        writeJson(join(run, "control.json"), { keepOpen: action === "keep" });
        context.ui.notify(action === "keep" ? "Worker will stay open." : "Worker will exit when idle.", "info");
      } else if (action === "parent" && launch.parentPane) {
        try { new Tmux().open(launch.parentPane); }
        catch (error) { context.ui.notify(`Parent is unavailable: ${error instanceof Error ? error.message : error}`, "error"); }
      } else context.ui.notify("/subagents keep | release | parent", "info");
    },
  });
}
