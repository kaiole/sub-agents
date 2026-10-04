import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { Manager } from "../src/manager.ts";
import { readJson, writeJson, type Activity, type Completion, type Job, type Loadout } from "../src/shared.ts";
import { Tmux } from "../src/tmux.ts";

async function waitFor(check: () => boolean, diagnosis: () => string, timeout = 20000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${diagnosis()}`);
}

let hasTmux = true;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); } catch { hasTmux = false; }

test("real Pi workers use background windows, complete, resume, inspect, steer, and cancel", { skip: !hasTmux, timeout: 120000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-subagents-integration-"));
  const socket = `pi-subagents-test-${process.pid}`;
  const tmux = new Tmux(socket);
  const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE, tmux: process.env.TMUX, pane: process.env.TMUX_PANE };
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  process.env.PI_OFFLINE = "1";
  writeJson(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), { enableInstallTelemetry: false, theme: "dark", tuiMode: "regular", retry: { enabled: false } });
  t.after(() => {
    try { tmux.command(["kill-server"]); } catch { /* server already stopped */ }
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
    if (previous.offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous.offline;
    if (previous.tmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previous.tmux;
    if (previous.pane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = previous.pane;
    rmSync(directory, { recursive: true, force: true });
  });
  // A separate socket keeps tests completely away from the user's live tmux windows.
  const parentPane = tmux.command(["-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "test", "-x", "100", "-y", "30", "sleep 120"]);
  const initialWindow = tmux.command(["display-message", "-p", "-t", parentPane, "#{window_id}"]);
  const initialLayout = tmux.command(["display-message", "-p", "-t", parentPane, "#{window_layout}"]);
  const results: Completion[] = [];
  const provider = fileURLToPath(new URL("fixtures/mock-provider.ts", import.meta.url));
  const loadout: Loadout = {
    agent: "test", cwd: directory, tools: ["read"], extensions: [provider],
    systemPrompt: "You are a deterministic test worker.", model: "subagent-test/mock", thinking: "off", approveProject: false,
  };
  const options = {
    directory: join(directory, "jobs"), parentPane, extensionPath: fileURLToPath(new URL("../index.ts", import.meta.url)),
    maxConcurrent: 2, tmux, invocation: (args: string[]) => ["pi", "--offline", ...args],
    onResult: (_job: Job, result: Completion) => results.push(result),
  };
  const manager = new Manager(options);
  const diagnose = (job: Job): string => {
    let screen = "(pane gone)";
    try { screen = tmux.command(["capture-pane", "-p", "-t", job.paneId!]); } catch { /* gone */ }
    return JSON.stringify({ status: job.status, results, activity: readJson(join(job.run, "activity.json")), exit: readJson(join(job.run, "exit.json")), screen }, null, 2);
  };
  const completed = async (job: Job, count: number) => waitFor(() => {
    manager.refresh();
    const exited = !tmux.panes().some((p) => p.paneId === job.paneId);
    if (exited) manager.refresh(); // Reconcile an exit that raced with the preceding refresh.
    return results.length >= count && exited;
  }, () => diagnose(job));

  const first = manager.spawn(loadout, "first task");
  assert.equal(tmux.command(["display-message", "-p", "-t", "test:", "#{window_id}"]), initialWindow, "spawn must not select the worker window");
  assert.equal(tmux.command(["display-message", "-p", "-t", parentPane, "#{window_layout}"]), initialLayout, "spawn must not resize/split the parent's window");
  await completed(first, 1);
  assert.equal(first.status, "done", diagnose(first));
  assert.equal(results[0].text, "Echo: first task");
  assert.equal(results[0].usage.input, 10);
  assert.ok(results[0].sessionFile);
  const sessionId = first.sessionId;
  const oldResult = first.resultFile;

  manager.message(first.name, "follow-up\nwith newlines");
  await completed(first, 2);
  assert.equal(first.sessionId, sessionId);
  assert.match(results[1].text, /first task \| follow-up\nwith newlines/);
  const session = readFileSync(results[1].sessionFile!, "utf8");
  assert.equal(session.split("\n").filter((line) => line.includes('"role":"user"')).length, 2);

  // Inspection resumes the real saved Pi TUI without making a model request.
  await manager.open(first.name);
  assert.equal(tmux.command(["display-message", "-p", "-t", "test:", "#{window_id}"]), first.windowId);
  assert.equal(readJson<Activity>(join(first.run, "activity.json"))?.keepOpen, true);
  assert.notEqual(first.resultFile, join(first.run, "result.json"));
  assert.notEqual(first.resultFile, oldResult);
  manager.release(first.name);
  await waitFor(() => { manager.refresh(); return !tmux.panes().some((p) => p.paneId === first.paneId); }, () => diagnose(first));
  assert.equal(results.length, 2, "inspection must not duplicate completion or invoke the model");

  const slow = manager.spawn(loadout, "SLOW initial", "steered", true);
  await waitFor(() => readJson<Activity>(join(slow.run, "activity.json"))?.status === "active", () => diagnose(slow));
  manager.message(slow.name, "additional instruction");
  await waitFor(() => { manager.refresh(); return results.length >= 3; }, () => diagnose(slow));
  assert.match(results[2].text, /SLOW initial \| additional instruction/);
  assert.equal(slow.status, "waiting");
  assert.ok(Number(manager.list().find((job) => job.name === slow.name)?.rssMiB) > 0, "Linux should report worker RSS");
  manager.release(slow.name);
  await completed(slow, 3);

  const cancelled = manager.spawn(loadout, "SLOW cancel", "cancelled");
  await waitFor(() => readJson<Activity>(join(cancelled.run, "activity.json"))?.status === "active", () => diagnose(cancelled));
  await manager.cancel(cancelled.name);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(results.at(-1)?.status, "cancelled");
  assert.equal(tmux.panes().filter((pane) => pane.run).length, 0);

  const failed = manager.spawn(loadout, "ERROR", "failed");
  await completed(failed, 5);
  assert.equal(failed.status, "error");
  assert.match(results.at(-1)!.text, /Deliberate mock failure/);
  const restored = new Manager(options);
  restored.refresh();
  assert.equal(results.length, 5, "restoring registry must not redeliver results");

  // Exercise the parent factory/tool wiring too, with a real worker and captured Pi API calls.
  process.env.TMUX = `${tmux.command(["display-message", "-p", "-t", parentPane, "#{socket_path}"])},0,0`;
  process.env.TMUX_PANE = parentPane;
  mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, "agents"), { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "agents", "worker.md"), `---\nname: worker\ndescription: Parent wiring test\ntools: [read]\nmodel: subagent-test/mock\nextensions: [${JSON.stringify(provider)}]\n---\nTest worker.`);
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, any>();
  const parentMessages: Array<{ message: any; options: any }> = [];
  const api = {
    on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); },
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    getSettings: () => ({ subagents: { maxConcurrent: 2, agentOverrides: { worker: { thinking: "low" } } } }),
    getAllTools: () => [], getThinkingLevel: () => "off",
    sendMessage: (message: any, options: any) => parentMessages.push({ message, options }),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: directory, model: { provider: "subagent-test", id: "mock" }, thinkingLevel: "off",
    isProjectTrusted: () => false, sessionManager: { getSessionId: () => "parent-wiring" },
    ui: { setStatus: () => {}, notify: () => {} },
  } as unknown as ExtensionContext;
  extension(api);
  assert.deepEqual([...tools.keys()], ["subagent", "subagent_message", "subagents_list", "subagents_status", "subagent_cancel"]);
  assert.ok(commands.has("subagents"));
  assert.equal(handlers.has("session_start"), true);
  handlers.get("session_start")!({}, ctx);
  t.after(() => handlers.get("session_shutdown")?.({}, ctx));
  const dispatched = await tools.get("subagent")!.execute("test-call", { agent: "worker", task: "parent delegated", name: "parent-worker" }, new AbortController().signal, undefined, ctx as any);
  assert.match((dispatched.content[0] as any).text, /asynchronously/);
  await waitFor(() => parentMessages.length === 1, () => JSON.stringify(parentMessages));
  assert.match(parentMessages[0].message.content, /Echo: parent delegated/);
  assert.deepEqual(parentMessages[0].options, { deliverAs: "followUp", triggerTurn: true });
  handlers.get("session_shutdown")!({}, ctx);
  handlers.get("session_start")!({}, ctx);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(parentMessages.length, 1, "parent reload must not redeliver completion");
  handlers.get("session_shutdown")!({}, ctx);
});
