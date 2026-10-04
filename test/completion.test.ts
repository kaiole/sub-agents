import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Manager } from "../src/manager.ts";
import { readJson, writeJson, type Completion } from "../src/shared.ts";
import { Tmux, type Pane } from "../src/tmux.ts";

class FakeTmux extends Tmux {
  live: Pane[] = [];
  override panes() { return [...this.live]; }
  override create(_parent: string, _name: string, _cwd: string, _script: string, run: string) {
    const surface = { windowId: "@1", paneId: "%1" };
    this.live = [{ ...surface, run, dead: false }];
    return surface;
  }
}

function setup(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-completions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tmux = new FakeTmux();
  const results: Completion[] = [];
  const manager = new Manager({ directory: dir, parentPane: "%0", extensionPath: "/extension.ts", maxConcurrent: 1, tmux, invocation: () => ["pi"], onResult: (_job, result) => results.push(result) });
  const job = manager.spawn({ agent: "worker", tools: ["read"], extensions: [], systemPrompt: "", thinking: "off", cwd: dir, approveProject: false }, "Task");
  return { manager, tmux, job, results };
}

test("completion outbox does not lose fast consecutive results between parent polls", (t) => {
  const { manager, job, results } = setup(t);
  const first: Completion = { id: "first", status: "done", text: "First", completedAt: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } };
  const second = { ...first, id: "second", text: "Second", completedAt: 2 };
  writeJson(join(job.run, "results", "00000000-first.json"), first);
  writeJson(join(job.run, "results", "00000001-second.json"), second);
  writeJson(join(job.run, "result.json"), second);
  manager.refresh();
  manager.refresh();
  assert.deepEqual(results.map((r) => r.text), ["First", "Second"]);
  assert.equal(job.resultFile, join(job.run, "results", "00000001-second.json"));
});

function requestClarification(job: ReturnType<typeof setup>["job"], tmux: FakeTmux) {
  const completion: Completion = {
    id: "question", status: "needs-input", text: "Which backend?", question: "Which backend?", completedAt: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
  };
  writeJson(join(job.run, "result.json"), completion);
  writeJson(join(job.run, "results", "00000000-question.json"), completion);
  writeJson(join(job.run, "activity.json"), { status: "waiting", detail: "clarification", waitingFor: "clarification", updatedAt: Date.now(), pid: process.pid });
  writeJson(join(job.run, "exit.json"), { exitCode: 0 });
  tmux.live = [];
}

function consumeMail(job: ReturnType<typeof setup>["job"]) {
  const mailbox = join(job.directory, "mailbox");
  for (const name of readdirSync(mailbox)) unlinkSync(join(mailbox, name));
}

test("needs-input is a durable terminal result that frees capacity and remains cancellable", async (t) => {
  const { manager, tmux, job, results } = setup(t);
  consumeMail(job);
  requestClarification(job, tmux);
  manager.refresh();
  manager.refresh();
  assert.equal(job.status, "needs-input");
  assert.equal(results.length, 1);
  assert.equal(manager.list()[0].waitingFor, "clarification");
  assert.equal(manager.list()[0].question, "Which backend?");
  assert.equal(manager.list()[0].live, false);
  const next = manager.spawn(job.loadout, "Independent task");
  assert.equal(next.status, "starting", "an exited clarification must not consume the worker slot");
  assert.throws(() => manager.message(job.name, "Use SQLite."), /limit reached/);
  assert.equal(readdirSync(join(job.directory, "mailbox")).length, 0, "failed reply must not be half-enqueued");
  await manager.cancel(job.name);
  manager.refresh();
  assert.equal(job.status, "cancelled");
  assert.equal(manager.list()[0].question, undefined);
  assert.equal(job.result?.question, "Which backend?", "cancellation preserves the question artifact");
});

test("a reply racing clarification shutdown resumes once, with the same session/loadout", (t) => {
  const { manager, tmux, job, results } = setup(t);
  consumeMail(job);
  manager.message(job.name, "Use SQLite.");
  const oldRun = job.run;
  const oldSession = job.sessionId;
  requestClarification(job, tmux);
  manager.refresh();
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "needs-input");
  assert.notEqual(job.run, oldRun);
  assert.equal(job.sessionId, oldSession);
  assert.equal(tmux.live.length, 1);
  const mailbox = join(job.directory, "mailbox");
  assert.equal(readdirSync(mailbox).length, 1);
  assert.equal(readJson<{ message: string }>(join(mailbox, readdirSync(mailbox)[0]))?.message, "Use SQLite.");
  assert.equal(readJson(join(job.run, "question.json")), undefined, "resumed answer starts without a pending question");
  manager.refresh();
  assert.equal(tmux.live.length, 1);
  assert.equal(results.length, 1);
});

test("startup failure before the child extension loads is reported and frees capacity", (t) => {
  const { manager, tmux, job, results } = setup(t);
  writeJson(join(job.run, "exit.json"), { exitCode: 127 });
  tmux.live = [];
  manager.refresh();
  manager.refresh();
  assert.equal(job.status, "error");
  assert.equal(results.length, 1);
  assert.match(results[0].text, /exit 127/);
});
