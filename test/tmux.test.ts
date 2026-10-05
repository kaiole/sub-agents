import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  let manager = new Manager(options);
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

  // Clarifications persist as needs-input, release their process/slot, and resume the same session.
  const question = manager.spawn(loadout, "QUESTION about implementation", "clarification");
  await completed(question, 6);
  assert.equal(question.status, "needs-input", diagnose(question));
  assert.equal(results.at(-1)?.question, "Which storage backend should I use?");
  assert.equal(manager.list().find((job) => job.name === question.name)?.waitingFor, "clarification");
  assert.equal(manager.list().find((job) => job.name === question.name)?.live, false);
  await manager.open(question.name);
  assert.equal(manager.list().find((job) => job.name === question.name)?.status, "needs-input");
  assert.equal(manager.list().find((job) => job.name === question.name)?.live, true);
  assert.equal(results.length, 6, "question inspection must not invoke the model or duplicate the request");
  manager.release(question.name);
  await completed(question, 6);
  assert.equal(question.status, "needs-input", "inspection/release must preserve the pending clarification");
  const questionSession = question.sessionId;
  const afterQuestion = new Manager(options);
  manager = afterQuestion;
  afterQuestion.refresh();
  assert.equal(afterQuestion.get(question.name).status, "needs-input");
  assert.equal(results.length, 6, "question must not be redelivered after registry restoration");
  afterQuestion.message(question.name, "Use SQLite.");
  await waitFor(() => {
    afterQuestion.refresh();
    return results.length === 7 && !tmux.panes().some((pane) => pane.paneId === afterQuestion.get(question.name).paneId);
  }, () => diagnose(afterQuestion.get(question.name)));
  assert.equal(afterQuestion.get(question.name).sessionId, questionSession);
  assert.equal(results.at(-1)?.status, "done");
  assert.match(results.at(-1)!.text, /QUESTION about implementation \| Use SQLite\./);

  // Preloaded skills arrive with the very first model request and survive follow-up launches.
  const skilled = manager.spawn({ ...loadout, skills: [{ name: "test-skill", path: join(directory, "skills", "test-skill", "SKILL.md"), content: "PRELOADED_SKILL_INSTRUCTIONS" }] }, "SKILL_CHECK", "skilled");
  await completed(skilled, 8);
  assert.equal(results.at(-1)?.status, "done", diagnose(skilled));
  manager.message(skilled.name, "SKILL_CHECK follow-up");
  await completed(skilled, 9);
  assert.equal(results.at(-1)?.status, "done", diagnose(skilled));
  assert.match(results.at(-1)!.text, /SKILL_CHECK \| SKILL_CHECK follow-up/);

  // Inspection must not resurrect a clarification that the parent explicitly cancelled.
  const cancelledQuestion = manager.spawn(loadout, "QUESTION to cancel", "cancelled-question");
  await completed(cancelledQuestion, 10);
  await manager.cancel(cancelledQuestion.name);
  assert.equal(cancelledQuestion.status, "cancelled");
  await manager.open(cancelledQuestion.name);
  const inspectedCancelled = manager.list().find((job) => job.name === cancelledQuestion.name)!;
  assert.equal(inspectedCancelled.status, "cancelled");
  assert.equal(inspectedCancelled.live, true);
  assert.equal(inspectedCancelled.waitingFor, "inspection");
  assert.equal(inspectedCancelled.question, undefined);
  assert.equal(readJson(join(cancelledQuestion.run, "question.json")), undefined);
  manager.release(cancelledQuestion.name);
  await completed(cancelledQuestion, 10);
  assert.equal(cancelledQuestion.status, "cancelled");
  manager = new Manager(options);
  manager.refresh();
  assert.equal(manager.get(cancelledQuestion.name).status, "cancelled");
  assert.equal(results.length, 10, "cancel/open/release/reload must not replay the historical question");

  // Real editing workers write only in their worktree, resume there, then integrate explicitly.
  const repository = join(directory, "repo");
  mkdirSync(repository);
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(repository, "parent.txt"), "committed\n");
  writeFileSync(join(repository, ".gitignore"), "ignored.txt\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  writeFileSync(join(repository, "parent.txt"), "unfinished parent\n");
  git("add", "parent.txt");
  writeFileSync(join(repository, "parent.txt"), "unfinished parent plus unstaged\n");
  writeFileSync(join(repository, "seed.txt"), "untracked input\n");
  writeFileSync(join(repository, "ignored.txt"), "not copied\n");
  const indexBefore = readFileSync(join(repository, ".git", "index"));
  const isolated = manager.spawn({ ...loadout, cwd: repository, tools: ["read", "write"] }, "WORKTREE_EDIT feature.txt", "isolated", false, { baseline: "current" });
  await completed(isolated, 11);
  assert.equal(isolated.status, "done", diagnose(isolated));
  assert.ok(isolated.worktree);
  assert.equal(readFileSync(join(isolated.loadout.cwd, "parent.txt"), "utf8"), "unfinished parent plus unstaged\n");
  assert.equal(readFileSync(join(isolated.loadout.cwd, "seed.txt"), "utf8"), "untracked input\n");
  assert.equal(existsSync(join(isolated.loadout.cwd, "ignored.txt")), false);
  assert.equal(existsSync(join(repository, "feature.txt")), false, "completion must not integrate automatically");
  const isolatedCwd = isolated.loadout.cwd;
  manager = new Manager(options);
  manager.message(isolated.name, "WORKTREE_EDIT followup.txt");
  const resumedIsolated = manager.get(isolated.name);
  await completed(resumedIsolated, 12);
  assert.equal(resumedIsolated.loadout.cwd, isolatedCwd);
  const review = manager.diff(isolated.name);
  assert.match(review.patch, /feature\.txt/);
  assert.match(review.patch, /followup\.txt/);
  assert.ok(!review.patch.includes("unfinished parent"));
  writeFileSync(join(repository, "later.txt"), "parent kept working\n");
  assert.equal(manager.integrate(isolated.name).state, "integrated");
  assert.equal(readFileSync(join(repository, "feature.txt"), "utf8"), "worker edit\n");
  assert.equal(readFileSync(join(repository, "followup.txt"), "utf8"), "worker edit\n");
  assert.equal(readFileSync(join(repository, "later.txt"), "utf8"), "parent kept working\n");
  assert.deepEqual(readFileSync(join(repository, ".git", "index")), indexBefore);
  assert.equal(existsSync(isolatedCwd), false);
  assert.throws(() => manager.message(isolated.name, "do more"), /integrated/);

  // Exercise the parent factory/tool wiring too, with a real worker and captured Pi API calls.
  process.env.TMUX = `${tmux.command(["display-message", "-p", "-t", parentPane, "#{socket_path}"])},0,0`;
  process.env.TMUX_PANE = parentPane;
  mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, "agents"), { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "agents", "worker.md"), `---\nname: worker\ndescription: Parent wiring test\ntools: [read, write]\nmodel: subagent-test/mock\nextensions: [${JSON.stringify(provider)}]\n---\nTest worker.`);
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
    cwd: repository, model: { provider: "subagent-test", id: "mock" }, thinkingLevel: "off",
    isProjectTrusted: () => false, sessionManager: { getSessionId: () => "parent-wiring" },
    ui: { setStatus: () => {}, notify: () => {} },
  } as unknown as ExtensionContext;
  extension(api);
  assert.deepEqual([...tools.keys()], ["subagent", "subagent_message", "subagents_list", "subagents_status", "subagent_cancel", "subagent_diff", "subagent_integrate", "subagent_discard"]);
  assert.ok(commands.has("subagents"));
  assert.equal(handlers.has("session_start"), true);
  handlers.get("session_start")!({}, ctx);
  t.after(() => handlers.get("session_shutdown")?.({}, ctx));
  const dispatched = await tools.get("subagent")!.execute("test-call", { agent: "worker", task: "parent delegated", name: "parent-worker", keepOpen: true }, new AbortController().signal, undefined, ctx as any);
  assert.match((dispatched.content[0] as any).text, /asynchronously/);
  await waitFor(() => parentMessages.length === 1, () => JSON.stringify(parentMessages));
  assert.match(parentMessages[0].message.content, /Echo: parent delegated/);
  assert.deepEqual(parentMessages[0].options, { deliverAs: "followUp", triggerTurn: true });
  const registry = readJson<{ jobs: Job[] }>(join(process.env.PI_CODING_AGENT_DIR!, "background-subagents", "parent-wiring", "registry.json"))!;
  const parentWorker = registry.jobs.find((job) => job.name === "parent-worker")!;
  const activityFile = join(parentWorker.run, "activity.json");
  const healthyActivity = readJson<Activity>(activityFile)!;
  writeJson(activityFile, { ...healthyActivity, updatedAt: Date.now() - 61_000 });
  await tools.get("subagents_status")!.execute("stalled-call", {}, new AbortController().signal, undefined, ctx as any);
  assert.equal(parentMessages[1].message.details.transition, "stalled");
  assert.deepEqual(parentMessages[1].options, { deliverAs: "followUp", triggerTurn: true });
  writeJson(activityFile, { ...healthyActivity, updatedAt: Date.now() });
  await tools.get("subagents_status")!.execute("recovered-call", {}, new AbortController().signal, undefined, ctx as any);
  assert.equal(parentMessages[2].message.details.transition, "recovered");
  await commands.get("subagents").handler("release parent-worker", ctx);
  await tools.get("subagent")!.execute("question-call", { agent: "worker", task: "QUESTION from parent", name: "parent-question" }, new AbortController().signal, undefined, ctx as any);
  await waitFor(() => parentMessages.length === 4, () => JSON.stringify(parentMessages));
  assert.equal(parentMessages[3].message.details.status, "needs-input");
  assert.match(parentMessages[3].message.content, /not task completion/);
  assert.match(parentMessages[3].message.content, /subagent_message\(\{ name: "parent-question"/);
  assert.deepEqual(parentMessages[3].options, { deliverAs: "followUp", triggerTurn: true });
  await tools.get("subagent_message")!.execute("answer-call", { name: "parent-question", message: "Use SQLite." }, new AbortController().signal, undefined, ctx as any);
  await waitFor(() => parentMessages.length === 5, () => JSON.stringify(parentMessages));
  assert.equal(parentMessages[4].message.details.status, "done");
  handlers.get("session_shutdown")!({}, ctx);
  handlers.get("session_start")!({}, ctx);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(parentMessages.length, 5, "parent reload must not redeliver completion, questions, or health transitions");
  // Model-facing review/integrate/discard operations use the same durable lifecycle.
  const apiCall = (tool: string, params: any) => tools.get(tool)!.execute(`call-${tool}`, params, new AbortController().signal, undefined, ctx as any);
  await apiCall("subagent", { agent: "worker", task: "WORKTREE_EDIT api-feature.txt", name: "api-isolated", baseline: "current" });
  await waitFor(() => parentMessages.length === 6, () => JSON.stringify(parentMessages));
  await waitFor(() => {
    const saved = readJson<{ jobs: Job[] }>(join(process.env.PI_CODING_AGENT_DIR!, "background-subagents", "parent-wiring", "registry.json"))!.jobs.find((job) => job.name === "api-isolated")!;
    return !tmux.panes().some((pane) => pane.paneId === saved.paneId);
  }, () => "api worker did not exit");
  assert.equal(existsSync(join(repository, "api-feature.txt")), false);
  const diff = await apiCall("subagent_diff", { name: "api-isolated" });
  assert.match((diff.content[0] as any).text, /api-feature\.txt/);
  const integrated = await apiCall("subagent_integrate", { name: "api-isolated" });
  assert.equal((integrated.details as any).state, "integrated");
  assert.equal(readFileSync(join(repository, "api-feature.txt"), "utf8"), "worker edit\n");
  await apiCall("subagent_cancel", { name: "parent-worker" });
  const discarded = await apiCall("subagent_discard", { name: "parent-worker" });
  assert.equal((discarded.details as any).state, "discarded");
  handlers.get("session_shutdown")!({}, ctx);
});
