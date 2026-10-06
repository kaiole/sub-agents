import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readJson, writeJson, type Activity, type Completion, type Control, type Launch, type Mail, type WaitingFor } from "./shared.ts";
import { Tmux } from "./tmux.ts";
import { readActivity } from "./health.ts";
import { installWorkerFooter } from "./worker-footer.ts";

/** Runs inside the worker's actual interactive Pi process. No stdin/send-keys automation. */
export function childExtension(pi: ExtensionAPI, run: string): void {
  const launch = readJson<Launch>(join(run, "launch.json"));
  if (!launch) throw new Error(`Missing launch snapshot: ${run}`);
  let ctx: ExtensionContext;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closing = false;
  const previousActivity = readActivity(join(run, "activity.json"));
  let idle = launch.inspection || previousActivity?.status === "waiting";
  let lastAssistant: AssistantMessage | undefined;
  let outcome: "completed" | "error" | "aborted" = "completed";
  let status: Activity["status"] = previousActivity?.status ?? "starting";
  let detail = previousActivity?.detail ?? "loading";
  let activitySince = previousActivity?.since ?? Date.now();
  let waitingFor: WaitingFor | undefined = previousActivity?.waitingFor;
  const activeTools = new Set([...launch.loadout.tools, "ask_question"]);
  const toolsInFlight = new Map<string, string>();
  const questionFile = join(run, "question.json");
  let pendingQuestion = readJson<{ question: string }>(questionFile)?.question;
  let lastHeartbeat = 0;
  let lastKeepOpen: boolean | undefined;
  let refreshFooter = () => {};
  let usage: Completion["usage"] = emptyUsage();
  const outbox = join(run, "results");
  let completionSequence = existsSync(outbox) ? readdirSync(outbox).length : 0;

  function emptyUsage(): Completion["usage"] { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }; }
  function control(): Control { return readJson<Control>(join(run, "control.json")) ?? { keepOpen: false }; }
  function heartbeat(): void {
    lastHeartbeat = Date.now();
    const previousKeepOpen = lastKeepOpen;
    lastKeepOpen = control().keepOpen;
    writeJson(join(run, "activity.json"), {
      status, detail, since: activitySince, waitingFor,
      pid: process.pid, sessionFile: ctx.sessionManager.getSessionFile(), updatedAt: lastHeartbeat, keepOpen: lastKeepOpen,
    } satisfies Activity);
    if (previousKeepOpen !== lastKeepOpen) refreshFooter();
  }
  function activity(next: Activity["status"], text: string, reason?: WaitingFor): void {
    if (status !== next || detail !== text || waitingFor !== reason) activitySince = Date.now();
    status = next;
    detail = text;
    waitingFor = reason;
    heartbeat();
  }
  function modelActivity(): void {
    if (waitingFor === "human-input") return;
    activity("active", toolsInFlight.size ? [...new Set(toolsInFlight.values())].join(", ") : "model");
  }
  function clearQuestion(): void {
    pendingQuestion = undefined;
    if (existsSync(questionFile)) unlinkSync(questionFile);
  }
  function complete(resultStatus: Completion["status"], text: string, question?: string): void {
    const result: Completion = {
      id: randomUUID(), status: resultStatus, text, question, usage,
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
      const deliverAs = mail.deliverAs === undefined ? "steer" : mail.deliverAs;
      if (deliverAs !== "steer" && deliverAs !== "followUp") throw new Error(`Invalid mailbox delivery mode: ${file}`);
      // Both modes trigger a turn when idle; while busy, Pi controls delivery timing.
      clearQuestion();
      pi.sendUserMessage(mail.message, { deliverAs, expandPromptTemplates: false });
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
    pi.setActiveTools([...activeTools]);
    refreshFooter = installWorkerFooter(pi, ctx, launch, () => lastKeepOpen ?? false);
    if (idle) {
      activity("waiting", pendingQuestion ? "clarification" : launch.inspection ? "inspection" : previousActivity?.detail ?? "finished",
        pendingQuestion ? "clarification" : launch.inspection ? "inspection" : previousActivity?.waitingFor ?? "release");
    } else activity("starting", "ready");
    timer = setInterval(tick, 250);
  });
  pi.on("input", () => { clearQuestion(); });
  pi.on("before_agent_start", () => { pi.setActiveTools([...activeTools]); });
  pi.on("tool_call", () => {
    if (pendingQuestion) return { block: true, terminate: true, reason: "A clarification is pending. Wait for the parent's reply before using more tools." };
  });
  // Session replacement would disconnect the worker from its recorded identity and mailbox.
  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));
  pi.on("cache_warming_decision", () => ({ action: "stop" }));
  pi.on("agent_start", () => {
    idle = false;
    lastAssistant = undefined;
    usage = emptyUsage();
    outcome = "completed";
    toolsInFlight.clear();
    activity("active", "model");
  });
  pi.on("tool_execution_start", (event) => { toolsInFlight.set(event.toolCallId, event.toolName); modelActivity(); });
  pi.on("tool_execution_end", (event) => { toolsInFlight.delete(event.toolCallId); modelActivity(); });
  pi.on("ui_prompt_start", (event) => { activity("waiting", event.title ?? event.kind, "human-input"); });
  pi.on("ui_prompt_end", () => { waitingFor = undefined; modelActivity(); });
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
    const resultStatus = outcome === "aborted" ? "cancelled" : outcome === "error" ? "error" : pendingQuestion ? "needs-input" : "done";
    complete(resultStatus, resultStatus === "needs-input" ? pendingQuestion! :
      lastAssistant?.errorMessage || text || (resultStatus === "done" ? "(No final text.)" : `Worker ${resultStatus}.`),
      resultStatus === "needs-input" ? pendingQuestion : undefined);
    idle = true;
    // After an interactive Escape/abort, leave the live TUI available for recovery.
    if (resultStatus === "cancelled") writeJson(join(run, "control.json"), { keepOpen: true });
    activity("waiting", resultStatus === "needs-input" ? "clarification" : resultStatus === "done" ? "finished" : resultStatus,
      resultStatus === "needs-input" ? "clarification" : resultStatus === "cancelled" ? "human-input" : "release");
    // Do not shut down synchronously in the settlement callback. Drain any racing messages first.
  });
  pi.on("session_shutdown", (event) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    refreshFooter = () => {};
    if (!closing && !idle && event.reason !== "reload") complete("cancelled", "Worker exited before completing its task.");
    closing = true;
  });

  pi.registerTool({
    name: "ask_question", label: "Ask parent",
    exposure: "model-only", executionMode: "sequential",
    description: "Request a clarification from the parent instead of guessing. Your task becomes needs-input; your session is saved and normally exits. The parent replies via subagent_message and you resume the same conversation. Use this tool alone, then stop.",
    promptGuidelines: ["When blocked by missing requirements or a material decision, ask the parent rather than guess. Call ask_question alone, not alongside other tools. Do not continue until the parent's reply."],
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 8000, description: "One actionable question with enough context for the parent to answer." }) }),
    async execute(_id, params) {
      const question = params.question.trim();
      if (!question) throw new Error("A nonempty clarification question is required.");
      if (pendingQuestion) throw new Error("A clarification is already pending.");
      pendingQuestion = question;
      writeJson(questionFile, { question });
      return {
        content: [{ type: "text", text: "Clarification requested. Stop and wait; the parent's reply will resume this saved conversation." }],
        details: { question }, terminate: true,
      };
    },
  });

  pi.registerCommand("subagents", {
    description: "Worker controls: keep, release, parent",
    handler: async (args, context) => {
      ctx = context;
      const action = args.trim();
      if (action === "keep" || action === "release") {
        writeJson(join(run, "control.json"), { keepOpen: action === "keep" });
        heartbeat();
        context.ui.notify(action === "keep" ? "Worker will stay open." : "Worker will exit when idle.", "info");
      } else if (action === "parent" && launch.parentPane) {
        try { new Tmux().open(launch.parentPane); }
        catch (error) { context.ui.notify(`Parent is unavailable: ${error instanceof Error ? error.message : error}`, "error"); }
      } else context.ui.notify("/subagents keep | release | parent", "info");
    },
  });
}
