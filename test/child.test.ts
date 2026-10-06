import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { childExtension } from "../src/child.ts";
import { readJson, writeJson, type Activity, type Completion, type Launch } from "../src/shared.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;

/** Capture the extension boundary; never start Pi, tmux, or a provider request. */
class FakePi {
  handlers = new Map<string, Handler[]>();
  tools = new Map<string, ToolDefinition>();
  activeTools: string[] = [];
  commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  sent: Array<{ message: string; options: unknown }> = [];
  on(name: string, handler: Handler) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
    return () => {};
  }
  registerTool(tool: ToolDefinition) { this.tools.set(tool.name, tool); }
  registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) { this.commands.set(name, command); }
  getThinkingLevel() { return "off"; }
  getAllTools() { return [{ name: "read", exposure: "direct" }, ...this.tools.values()]; }
  setActiveTools(tools: string[]) { this.activeTools = tools; }
  sendUserMessage(message: string, options: unknown) { this.sent.push({ message, options }); }
  emit(name: string, ctx: ExtensionContext, event: Record<string, unknown> = {}) {
    return (this.handlers.get(name) ?? []).map((handler) => handler({ type: name, ...event }, ctx));
  }
}

function setup(t: test.TestContext, options: { keepOpen?: boolean; inspection?: boolean; question?: string; isolation?: Launch["isolation"] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-subagents-child-"));
  const run = join(directory, "run");
  const mailbox = join(directory, "mailbox");
  mkdirSync(mailbox);
  const sessionFile = join(directory, "session.jsonl");
  const launch: Launch = {
    name: "worker", sessionId: "saved-session", mailbox, inspection: options.inspection ?? false,
    isolation: options.isolation ?? "shared",
    loadout: { agent: "worker", tools: ["read"], extensions: [], systemPrompt: "", thinking: "off", cwd: directory, approveProject: false },
  };
  writeJson(join(run, "launch.json"), launch);
  writeJson(join(run, "control.json"), { keepOpen: options.keepOpen ?? false });
  if (options.question) writeJson(join(run, "question.json"), { question: options.question });

  let now = 1_000_000;
  let sequence = 0;
  const intervals = new Map<number, () => void>();
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setInterval", (callback: () => void) => {
    const id = ++sequence;
    intervals.set(id, callback);
    return id as unknown as ReturnType<typeof setInterval>;
  });
  t.mock.method(globalThis, "clearInterval", (id: ReturnType<typeof setInterval>) => { intervals.delete(id as unknown as number); });

  const workers: Array<{ emit(name: string, event?: Record<string, unknown>): unknown[] }> = [];
  function attach(reason = "startup") {
    const pi = new FakePi();
    let shutdowns = 0;
    let aborts = 0;
    let isIdle = true;
    let pendingMessages = false;
    let footer: ReturnType<FooterFactory>;
    let footerRenders = 0;
    const ctx = {
      mode: "tui", getContextUsage: () => undefined,
      sessionManager: { getSessionFile: () => sessionFile, getCwd: () => directory },
      ui: {
        setFooter(factory: FooterFactory) {
          footer = factory(
            { requestRender: () => { footerRenders++; } } as Parameters<FooterFactory>[0],
            { fg: (_color: string, text: string) => text } as Parameters<FooterFactory>[1],
            { getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1 } as Parameters<FooterFactory>[2],
          );
        },
        notify() {},
      },
      isIdle: () => isIdle, hasPendingMessages: () => pendingMessages,
      shutdown: () => { shutdowns++; }, abort: () => { aborts++; },
    } as unknown as ExtensionContext;
    childExtension(pi as unknown as ExtensionAPI, run);
    const worker = {
      pi, ctx,
      footer: () => footer.render(200)[0],
      get footerRenders() { return footerRenders; },
      emit: (name: string, event: Record<string, unknown> = {}) => pi.emit(name, ctx, event),
      ask: (question: string) => pi.tools.get("ask_question")!.execute("ask-1", { question }, undefined, undefined, ctx as ExtensionToolContext),
      start() { isIdle = false; pi.emit("agent_start", ctx); },
      settle(outcome: "completed" | "error" | "aborted" = "completed") {
        pi.emit("agent_before_settle", ctx, { outcome });
        isIdle = true;
        return pi.emit("agent_settled", ctx);
      },
      setIdle: (value: boolean) => { isIdle = value; },
      setPending: (value: boolean) => { pendingMessages = value; },
      get shutdowns() { return shutdowns; }, get aborts() { return aborts; },
    };
    workers.push(worker);
    worker.emit("session_start", { reason });
    return worker;
  }
  t.after(() => {
    for (const worker of workers) worker.emit("session_shutdown", { reason: "reload" });
    assert.equal(intervals.size, 0, "every worker timer must be cleaned up");
    rmSync(directory, { recursive: true, force: true });
  });
  const worker = attach();
  return {
    ...worker, worker, run, mailbox, sessionFile, attach,
    advance: (ms: number) => { now += ms; },
    tick: () => { for (const callback of [...intervals.values()]) callback(); },
    activity: () => readJson<Activity>(join(run, "activity.json"))!,
    result: () => readJson<Completion>(join(run, "result.json"))!,
    results: () => readdirSync(join(run, "results")).sort().map((file) => readJson<Completion>(join(run, "results", file))!),
    get now() { return now; },
  };
}

function assistant(text: string, errorMessage?: string) {
  return { message: { role: "assistant", content: [{ type: "text", text }], errorMessage } };
}

test("worker footer reflects parent pinning and abort recovery without duplicate status text", (t) => {
  const h = setup(t, { isolation: "worktree" });
  assert.match(h.footer(), /^ \[worker:worker\] worktree \| no-model \| \?% \[\?\/0\]/);
  assert.match(h.footer(), / auto-exit$/);
  const renders = h.worker.footerRenders;
  writeJson(join(h.run, "control.json"), { keepOpen: true });
  h.tick();
  assert.match(h.footer(), / pinned$/);
  assert.equal(h.worker.footerRenders, renders + 1);
  h.advance(6000);
  h.tick();
  assert.equal(h.worker.footerRenders, renders + 1, "unchanged heartbeats do not redraw the footer");
  writeJson(join(h.run, "control.json"), { keepOpen: false });
  h.tick();
  assert.match(h.footer(), / auto-exit$/);
  h.worker.start();
  h.worker.settle("aborted");
  assert.match(h.footer(), / pinned$/, "abort pins the footer immediately");
});

test("worker keep/release commands refresh the footer immediately", async (t) => {
  const h = setup(t);
  const command = h.pi.commands.get("subagents")!;
  await command.handler("keep", h.ctx as ExtensionCommandContext);
  assert.match(h.footer(), / pinned$/);
  await command.handler("release", h.ctx as ExtensionCommandContext);
  assert.match(h.footer(), / auto-exit$/);
});

test("ask_question is automatically registered and activated as a sequential model-only tool", (t) => {
  const h = setup(t);
  const tool = h.pi.tools.get("ask_question")!;
  assert.equal(tool.exposure, "model-only");
  assert.equal(tool.executionMode, "sequential");
  assert.deepEqual(h.pi.activeTools, ["read", "ask_question"]);
  h.pi.activeTools = [];
  h.emit("before_agent_start");
  assert.deepEqual(h.pi.activeTools, ["read", "ask_question"]);
});

test("a question terminates without a continuation and settles into the durable needs-input outbox", async (t) => {
  const h = setup(t);
  h.worker.start();
  h.emit("message_end", assistant("I need a decision."));
  const toolResult = await h.ask("  Which database should I use?  ");
  assert.equal(toolResult.terminate, true, "the agent must not request another model turn");
  assert.deepEqual(readJson(join(h.run, "question.json")), { question: "Which database should I use?" });
  assert.deepEqual(h.emit("tool_call", { toolName: "read" }), [{
    block: true, terminate: true,
    reason: "A clarification is pending. Wait for the parent's reply before using more tools.",
  }]);
  assert.deepEqual(h.worker.settle(), [undefined]);
  assert.equal(h.result().status, "needs-input");
  assert.equal(h.result().question, "Which database should I use?");
  assert.equal(h.result().text, "Which database should I use?");
  assert.equal(h.result().sessionFile, h.sessionFile);
  assert.deepEqual(h.results(), [h.result()]);
  assert.deepEqual(h.pi.sent, [], "asking must not enqueue a continuation");
  assert.equal(h.activity().waitingFor, "clarification");
  assert.equal(h.worker.shutdowns, 0, "settlement must allow racing parent mail to drain");
  h.tick();
  assert.equal(h.worker.shutdowns, 1, "the default exits on the following control tick");
  h.tick();
  assert.equal(h.worker.shutdowns, 1);
});

test("questions reject blank and duplicate requests without replacing the persisted question", async (t) => {
  const h = setup(t, { keepOpen: true });
  await assert.rejects(h.ask("   "), /nonempty/);
  assert.equal(existsSync(join(h.run, "question.json")), false);
  await h.ask("First decision?");
  await assert.rejects(h.ask("Second decision?"), /already pending/);
  assert.deepEqual(readJson(join(h.run, "question.json")), { question: "First decision?" });
});

test("a parent mailbox reply clears clarification before the next turn, including the auto-exit race", async (t) => {
  const h = setup(t);
  h.worker.start();
  await h.ask("Which branch?");
  h.worker.settle();
  writeJson(join(h.mailbox, "000001.json"), { message: "Use main." });
  h.tick();
  assert.equal(h.worker.shutdowns, 0);
  assert.equal(existsSync(join(h.run, "question.json")), false);
  assert.deepEqual(h.pi.sent, [{ message: "Use main.", options: { deliverAs: "steer", expandPromptTemplates: false } }]);
  assert.deepEqual(readdirSync(h.mailbox), []);
  assert.deepEqual(h.emit("tool_call", { toolName: "read" }), [undefined]);
  h.worker.start();
  h.emit("message_end", assistant("Implemented on main."));
  h.worker.settle();
  assert.deepEqual(h.results().map((result) => result.status), ["needs-input", "done"]);
  assert.equal(h.result().text, "Implemented on main.");
  assert.equal(h.result().question, undefined);
  assert.equal(h.activity().waitingFor, "release");
  h.tick();
  assert.equal(h.worker.shutdowns, 1);
});

test("mailbox delivery preserves native steering/follow-up modes and legacy defaults", (t) => {
  const h = setup(t);
  h.worker.start();
  const messages = [
    { message: "Legacy" },
    { message: "Steer", deliverAs: "steer" },
    { message: "Follow up", deliverAs: "followUp" },
  ];
  messages.forEach((mail, index) => writeJson(join(h.mailbox, `${index}.json`), mail));
  h.tick();
  assert.deepEqual(h.pi.sent, [
    { message: "Legacy", options: { deliverAs: "steer", expandPromptTemplates: false } },
    { message: "Steer", options: { deliverAs: "steer", expandPromptTemplates: false } },
    { message: "Follow up", options: { deliverAs: "followUp", expandPromptTemplates: false } },
  ]);
  assert.deepEqual(readdirSync(h.mailbox), []);
  assert.equal(h.worker.shutdowns, 0);
});

test("follow-up mail racing settlement starts another turn instead of auto-exiting", (t) => {
  const h = setup(t);
  h.worker.start();
  h.emit("message_end", assistant("First answer."));
  h.worker.settle();
  writeJson(join(h.mailbox, "000001.json"), { message: "Next", deliverAs: "followUp" });
  h.tick();
  assert.equal(h.worker.shutdowns, 0);
  assert.deepEqual(h.pi.sent, [{ message: "Next", options: { deliverAs: "followUp", expandPromptTemplates: false } }]);
});

test("invalid mailbox delivery modes fail without submitting or deleting the message", (t) => {
  const h = setup(t);
  writeJson(join(h.mailbox, "000001.json"), { message: "Invalid", deliverAs: "bad" });
  h.tick();
  assert.deepEqual(h.pi.sent, []);
  assert.equal(h.result().status, "error");
  assert.match(h.result().text, /Invalid mailbox delivery mode/);
  assert.equal(readdirSync(h.mailbox).length, 1);
  assert.equal(h.worker.aborts, 1);
  assert.equal(h.worker.shutdowns, 1);
});

test("interactive input clears a pending question and a subsequent turn completes normally", async (t) => {
  const h = setup(t, { keepOpen: true });
  h.worker.start();
  await h.ask("May I proceed?");
  h.worker.settle();
  h.emit("input", { text: "Yes.", source: "interactive" });
  assert.equal(existsSync(join(h.run, "question.json")), false);
  assert.deepEqual(h.emit("tool_call", { toolName: "read" }), [undefined]);
  h.worker.start();
  h.emit("message_end", assistant("Done."));
  h.worker.settle();
  assert.equal(h.result().status, "done");
  assert.equal(h.result().question, undefined);
  h.tick();
  assert.equal(h.worker.shutdowns, 0);
});

test("pending clarification survives an extension reload and outbox sequencing remains durable", async (t) => {
  const h = setup(t, { keepOpen: true });
  h.worker.start();
  await h.ask("Which format?");
  h.worker.settle();
  const original = h.result();
  const originalSince = h.activity().since;
  h.advance(6000);
  h.tick();
  assert.equal(h.activity().since, originalSince);
  h.emit("session_shutdown", { reason: "reload" });
  assert.deepEqual(h.results(), [original], "reload must not append a cancellation");
  const restored = h.attach("reload");
  assert.equal(h.activity().status, "waiting");
  assert.equal(h.activity().waitingFor, "clarification");
  assert.equal(h.activity().since, originalSince, "reload must preserve the clarification's transition age");
  h.advance(6000);
  h.tick();
  assert.equal(h.activity().since, originalSince);
  assert.equal(restored.shutdowns, 0, "kept-open clarification remains available after reload");
  const blocked = restored.emit("tool_call", { toolName: "read" })[0] as { block: boolean; terminate: boolean };
  assert.equal(blocked.block, true);
  assert.equal(blocked.terminate, true);
  await assert.rejects(restored.ask("A new question?"), /already pending/);
  restored.emit("input", { text: "JSON.", source: "interactive" });
  restored.start();
  restored.emit("message_end", assistant("Produced JSON."));
  restored.settle();
  assert.deepEqual(h.results().map((result) => result.status), ["needs-input", "done"]);
  assert.equal(h.results()[0].id, original.id);
});

for (const [outcome, expected] of [["error", "error"], ["aborted", "cancelled"]] as const) {
  test(`${outcome} takes priority over a pending clarification`, async (t) => {
    const h = setup(t);
    h.worker.start();
    await h.ask("A pending decision?");
    h.emit("message_end", assistant("", "Provider failed."));
    h.worker.settle(outcome);
    assert.equal(h.result().status, expected);
    assert.equal(h.result().question, undefined);
    assert.equal(h.result().text, "Provider failed.");
    assert.equal(h.activity().waitingFor, outcome === "aborted" ? "human-input" : "release");
    h.tick();
    assert.equal(h.worker.shutdowns, outcome === "aborted" ? 0 : 1);
  });
}

test("explicit kept-open inspection retains the session, then release exits when idle", (t) => {
  const h = setup(t, { inspection: true, keepOpen: true });
  assert.equal(h.activity().status, "waiting");
  assert.equal(h.activity().waitingFor, "inspection");
  h.advance(6000);
  h.tick();
  assert.equal(h.worker.shutdowns, 0);
  writeJson(join(h.run, "control.json"), { keepOpen: false });
  h.tick();
  assert.equal(h.worker.shutdowns, 1);
});

test("inspection of a saved clarification keeps its question until a reply", (t) => {
  const h = setup(t, { inspection: true, keepOpen: true, question: "Which target?" });
  assert.equal(h.activity().waitingFor, "clarification");
  h.tick();
  assert.equal(h.worker.shutdowns, 0);
  assert.deepEqual(readJson(join(h.run, "question.json")), { question: "Which target?" });
  h.emit("input", { text: "Linux.", source: "interactive" });
  assert.equal(existsSync(join(h.run, "question.json")), false);
});

test("activity since is transition age, not heartbeat age or a repeated identical event", (t) => {
  const h = setup(t, { keepOpen: true });
  const started = h.activity().since;
  h.advance(6000);
  h.tick();
  assert.equal(h.activity().since, started);
  assert.equal(h.activity().updatedAt, h.now);
  h.worker.start();
  const modelSince = h.now;
  assert.equal(h.activity().since, modelSince);
  h.advance(1000);
  h.emit("tool_execution_start", { toolCallId: "r1", toolName: "read" });
  const toolSince = h.now;
  assert.equal(h.activity().since, toolSince);
  h.advance(6000);
  h.tick();
  assert.equal(h.activity().since, toolSince);
  assert.equal(h.activity().updatedAt, h.now);
  h.emit("tool_execution_start", { toolCallId: "r2", toolName: "read" });
  assert.equal(h.activity().since, toolSince, "identical activity must retain its transition time");
});

test("parallel tool activity returns to model only after all tool calls finish", (t) => {
  const h = setup(t, { keepOpen: true });
  h.worker.start();
  h.emit("tool_execution_start", { toolCallId: "r1", toolName: "read" });
  h.emit("tool_execution_start", { toolCallId: "b1", toolName: "bash" });
  assert.equal(h.activity().detail, "read, bash");
  h.advance(1000);
  h.emit("tool_execution_end", { toolCallId: "r1", toolName: "read" });
  assert.equal(h.activity().status, "active");
  assert.equal(h.activity().detail, "bash");
  assert.equal(h.activity().since, h.now);
  h.emit("tool_execution_start", { toolCallId: "b2", toolName: "bash" });
  h.emit("tool_execution_end", { toolCallId: "b1", toolName: "bash" });
  assert.equal(h.activity().detail, "bash", "same-named tools are tracked by call ID");
  h.emit("tool_execution_end", { toolCallId: "b2", toolName: "bash" });
  assert.equal(h.activity().detail, "model");
});

test("human UI prompts stay waiting while parallel tools finish, then resume remaining activity", (t) => {
  const h = setup(t, { keepOpen: true });
  h.worker.start();
  h.emit("tool_execution_start", { toolCallId: "r1", toolName: "read" });
  h.emit("tool_execution_start", { toolCallId: "b1", toolName: "bash" });
  h.advance(1000);
  h.emit("ui_prompt_start", { title: "Approve command?", kind: "confirm" });
  const promptSince = h.now;
  assert.equal(h.activity().waitingFor, "human-input");
  assert.equal(h.activity().detail, "Approve command?");
  h.advance(6000);
  h.emit("tool_execution_end", { toolCallId: "r1", toolName: "read" });
  h.tick();
  assert.equal(h.activity().status, "waiting");
  assert.equal(h.activity().since, promptSince);
  h.emit("ui_prompt_end");
  assert.equal(h.activity().status, "active");
  assert.equal(h.activity().detail, "bash");
  assert.equal(h.activity().waitingFor, undefined);
  h.emit("tool_execution_end", { toolCallId: "b1", toolName: "bash" });
  assert.equal(h.activity().detail, "model");
});

test("the control tick does not close before pending messages settle", (t) => {
  const h = setup(t);
  h.worker.start();
  h.emit("message_end", assistant("Done."));
  h.worker.settle();
  h.worker.setPending(true);
  h.tick();
  assert.equal(h.worker.shutdowns, 0);
  h.worker.setPending(false);
  h.worker.setIdle(false);
  h.tick();
  assert.equal(h.worker.shutdowns, 0);
  h.worker.setIdle(true);
  h.tick();
  assert.equal(h.worker.shutdowns, 1);
});
