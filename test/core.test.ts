import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseAgent, resolveLoadout } from "../src/agents.ts";
import { Manager } from "../src/manager.ts";
import { capOutput, readJson, uniqueName, writeJson, type Activity, type Completion, type Job, type Loadout, type Mail, type MessageDelivery } from "../src/shared.ts";
import { quote, Tmux, type Pane } from "../src/tmux.ts";

const loadout: Loadout = { agent: "worker", tools: ["read"], extensions: [], systemPrompt: "Be useful.", thinking: "low", cwd: tmpdir(), model: "test/mock", approveProject: false };

class FakeTmux extends Tmux {
  live: Pane[] = [];
  next = 1;
  scripts: string[] = [];
  focused?: string;
  override create(_parent: string, _name: string, _cwd: string, script: string, run: string) {
    this.scripts.push(readFileSync(script, "utf8"));
    const n = this.next++;
    const surface = { windowId: `@${n}`, paneId: `%${n}` };
    this.live.push({ ...surface, run, dead: false });
    return surface;
  }
  override panes() { return [...this.live]; }
  override open(pane: string) { this.focused = pane; }
  override kill(pane: string) { this.live = this.live.filter((p) => p.paneId !== pane); }
}

function setup(t: test.TestContext, maxConcurrent = 4) {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-unit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tmux = new FakeTmux();
  const results: Completion[] = [];
  const options = { directory: dir, parentPane: "%0", extensionPath: "/extension.ts", maxConcurrent, tmux, invocation: (args: string[]) => ["pi", ...args], onResult: (_job: Job, result: Completion) => results.push(result) };
  return { dir, tmux, results, options, manager: new Manager(options) };
}
function consume(job: Job) {
  const mailbox = join(job.directory, "mailbox");
  for (const file of readdirSync(mailbox)) unlinkSync(join(mailbox, file));
}
function finish(job: Job, tmux: FakeTmux, consumeMail = true) {
  if (consumeMail) consume(job);
  const sessionFile = join(job.directory, "session.jsonl");
  writeFileSync(sessionFile, "saved");
  writeJson(join(job.run, "activity.json"), { status: "waiting", detail: "finished", updatedAt: Date.now(), pid: process.pid, keepOpen: false, sessionFile } satisfies Activity);
  writeJson(join(job.run, "result.json"), { id: "result-" + job.run, status: "done", text: "Completed.", completedAt: Date.now(), sessionFile, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } } satisfies Completion);
  writeJson(join(job.run, "exit.json"), { exitCode: 0 });
  tmux.kill(job.paneId!);
}

test("private atomic JSON storage and malformed file errors", (t) => {
  const { dir } = setup(t);
  const file = join(dir, "nested", "state.json");
  assert.equal(readJson(file), undefined);
  writeJson(file, { foo: "bar" });
  assert.deepEqual(readJson(file), { foo: "bar" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700);
  writeFileSync(file, "not JSON");
  assert.throws(() => readJson(file), /Cannot read/);
});

test("names and shell quoting reject injection or preserve it as literal data", () => {
  assert.equal(uniqueName("scout", ["scout", "scout-2"]), "scout-3");
  assert.throws(() => uniqueName("bad; rm -rf /", []));
  assert.equal(quote("it's $(not a command)"), "'it'\\''s $(not a command)'");
});

test("byte-bounded truncation preserves Unicode", () => {
  const text = "你好🙂".repeat(20);
  const capped = capOutput(text, "/result.json", 11);
  assert.ok(!capped.includes("\ufffd"));
  assert.match(capped, /Full result: \/result.json/);
  assert.equal(capOutput("short", "unused"), "short");
});

test("profiles accept YAML arrays/string lists and reject unsupported restrictions", () => {
  const profile = parseAgent("---\nname: scout\ndescription: Test\ntools: [read, grep]\nthinking: low\nauto-exit: false\n---\nInstructions", "/agents/scout.md");
  assert.deepEqual(profile.tools, ["read", "grep"]);
  assert.equal(profile.keepOpen, true);
  assert.equal(profile.systemPrompt, "Instructions");
  assert.deepEqual(parseAgent("---\nname: worker\ndescription: Test\ntools: read, bash\n---", "/worker.md").tools, ["read", "bash"]);
  assert.throws(() => parseAgent("---\nname: x\ndescription: Test\ntools: [read, 7]\n---", "/x.md"), /tools/);
  assert.throws(() => parseAgent("---\nname: x\ndescription: Test\ntools: read\nsubagent_agents: worker\n---", "/x.md"), /Nested/);
});

test("tool source resolution loads only backing extensions and keeps cwd trust scoped", (t) => {
  const { dir } = setup(t);
  mkdirSync(join(dir, "other"));
  const agent = parseAgent("---\nname: research\ndescription: Test\ntools: [read, web_search]\n---", "/research.md");
  const pi = { getAllTools: () => [{ name: "web_search", sourceInfo: { path: "/firecrawl.ts" } }], getThinkingLevel: () => "low" } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, model: { provider: "test", id: "model" }, isProjectTrusted: () => true } as unknown as ExtensionContext;
  assert.deepEqual(resolveLoadout(agent, pi, ctx).extensions, ["/firecrawl.ts"]);
  assert.equal(resolveLoadout(agent, pi, ctx).approveProject, true);
  assert.equal(resolveLoadout(agent, pi, ctx, "other").approveProject, false);
  const missing = { ...pi, getAllTools: () => [] } as unknown as ExtensionAPI;
  assert.throws(() => resolveLoadout(agent, missing, ctx), /unavailable/);
});

test("spawn returns immediately, snapshots loadout, and enforces live capacity", (t) => {
  const { manager, tmux } = setup(t, 1);
  const job = manager.spawn(loadout, "Do work.\nDon't touch unrelated files.");
  assert.equal(job.name, "worker");
  assert.equal(tmux.focused, undefined);
  assert.equal(tmux.live.length, 1);
  assert.match(tmux.scripts[0], /--no-extensions/);
  assert.ok(!tmux.scripts[0].includes("send-keys"));
  assert.ok(!tmux.scripts[0].includes("Do work"));
  assert.deepEqual(readJson<{ loadout: Loadout }>(join(job.run, "launch.json"))?.loadout, loadout);
  assert.throws(() => manager.spawn(loadout, "Other work"), /limit reached/);
  finish(job, tmux);
  manager.refresh();
  assert.equal(manager.spawn(loadout, "Next task").name, "worker-2");
});

test("completions survive reload without duplicate parent notifications", (t) => {
  const { manager, tmux, options, results } = setup(t);
  const job = manager.spawn(loadout, "Task");
  finish(job, tmux);
  manager.refresh();
  manager.refresh();
  assert.equal(job.status, "done");
  assert.equal(results.length, 1);
  const restored = new Manager(options);
  restored.refresh();
  assert.equal(results.length, 1);
  assert.equal(restored.get(job.name).result?.text, "Completed.");
});

test("message delivery defaults to steering and persists explicit modes across manager reloads", (t) => {
  const { manager, options } = setup(t);
  const job = manager.spawn(loadout, "Task");
  const mailbox = join(job.directory, "mailbox");
  const mail = () => readdirSync(mailbox).sort().map((file) => readJson<Mail>(join(mailbox, file))!);
  assert.deepEqual(mail(), [{ message: "Task", deliverAs: "steer" }]);
  consume(job);
  manager.message(job.name, "Default");
  manager.message(job.name, "Explicit steering", "steer");
  const restored = new Manager(options);
  restored.message(job.name, "Deferred follow-up", "followUp");
  assert.deepEqual(mail().sort((a, b) => a.message.localeCompare(b.message)), [
    { message: "Default", deliverAs: "steer" },
    { message: "Deferred follow-up", deliverAs: "followUp" },
    { message: "Explicit steering", deliverAs: "steer" },
  ]);
  assert.throws(() => restored.message(job.name, "Invalid", "bad" as MessageDelivery), /deliverAs/);
  assert.equal(mail().length, 3, "invalid modes must not enqueue mail");
});

test("follow-ups resume the same loadout/session and preserve earlier result paths", (t) => {
  const { manager, tmux } = setup(t);
  const job = manager.spawn(loadout, "Task");
  finish(job, tmux);
  manager.refresh();
  const oldRun = job.run;
  const session = job.sessionId;
  manager.message(job.name, "Follow up\nwith literal newlines.", "followUp");
  const mailbox = join(job.directory, "mailbox");
  assert.deepEqual(readJson<Mail>(join(mailbox, readdirSync(mailbox)[0])), {
    message: "Follow up\nwith literal newlines.", deliverAs: "followUp",
  });
  assert.notEqual(job.run, oldRun);
  assert.equal(job.sessionId, session);
  assert.equal(manager.list()[0].resultFile, join(oldRun, "result.json"));
  assert.deepEqual(readJson<{ loadout: Loadout }>(join(job.run, "launch.json"))?.loadout, loadout);
});

test("mail arriving at auto-exit is resumed without two session writers", (t) => {
  const { manager, tmux, results } = setup(t);
  const job = manager.spawn(loadout, "Task");
  consume(job);
  manager.message(job.name, "Racing followup", "followUp");
  const oldRun = job.run;
  finish(job, tmux, false);
  manager.refresh();
  assert.notEqual(job.run, oldRun);
  assert.equal(tmux.live.length, 1);
  assert.equal(results.length, 1);
  const mailbox = join(job.directory, "mailbox");
  assert.equal(readdirSync(mailbox).length, 1);
  assert.deepEqual(readJson<Mail>(join(mailbox, readdirSync(mailbox)[0])), {
    message: "Racing followup", deliverAs: "followUp",
  });
});

test("unexpected pane loss is reported once and reused pane IDs are not owned", (t) => {
  const { manager, tmux, results } = setup(t);
  const job = manager.spawn(loadout, "Task");
  tmux.live = [{ windowId: job.windowId!, paneId: job.paneId!, dead: false, run: "someone-else" }];
  manager.refresh();
  manager.refresh();
  assert.equal(job.status, "error");
  assert.equal(results.length, 1);
  assert.match(results[0].text, /unexpectedly/);
  assert.equal(tmux.live.length, 1);
});
