import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatDuration, heartbeatHealth, readActivity, STALE_HEARTBEAT_MS } from "../src/health.ts";
import { Manager } from "../src/manager.ts";
import { readJson, writeJson, type Activity, type Completion, type Job } from "../src/shared.ts";
import { Tmux, type Pane } from "../src/tmux.ts";

class FakeTmux extends Tmux {
  live: Pane[] = [];
  next = 0;
  override create(_parent: string, _name: string, _cwd: string, _script: string, run: string) {
    const id = ++this.next;
    const surface = { windowId: `@${id}`, paneId: `%${id}` };
    this.live.push({ ...surface, run, dead: false });
    return surface;
  }
  override panes() { return [...this.live]; }
  override kill(paneId: string) { this.live = this.live.filter((pane) => pane.paneId !== paneId); }
}

function tempDirectory(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "pi-subagents-health-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function setup(t: test.TestContext, staleAfterMs: number | undefined = 1000) {
  const directory = tempDirectory(t);
  let now = 1_000_000;
  const tmux = new FakeTmux();
  const alerts: Array<{ name: string; transition: "stalled" | "recovered" }> = [];
  const results: Completion[] = [];
  const options = {
    directory, parentPane: "%0", extensionPath: "/extension.ts", maxConcurrent: 4,
    tmux, invocation: () => ["pi"], now: () => now, staleAfterMs,
    onResult: (_job: Job, result: Completion) => results.push(result),
    onHealth: (job: Job, transition: "stalled" | "recovered") => {
      const persisted = readJson<{ jobs: Job[] }>(join(directory, "registry.json"))!.jobs.find((saved) => saved.name === job.name)!;
      assert.equal(persisted.health, job.health, "persist health before notifying so reconstruction cannot duplicate an alert");
      alerts.push({ name: job.name, transition });
    },
  };
  const manager = new Manager(options);
  const job = manager.spawn({ agent: "worker", tools: ["read"], extensions: [], systemPrompt: "", thinking: "off", cwd: directory, approveProject: false }, "Task");
  // Model the worker having consumed its initial task, avoiding automatic restarts on exit.
  const mailbox = join(job.directory, "mailbox");
  for (const file of readdirSync(mailbox)) unlinkSync(join(mailbox, file));
  return {
    manager, job, tmux, alerts, results, options,
    advance: (ms: number) => { now += ms; },
    heartbeat: (patch: Partial<Activity> = {}) => writeJson(join(job.run, "activity.json"), {
      status: "active", detail: "bash", since: job.startedAt, updatedAt: now,
      pid: process.pid, keepOpen: false, ...patch,
    } satisfies Activity),
    complete: (status: Completion["status"], live = false) => {
      const result: Completion = {
        id: `result-${status}`, status, text: status === "needs-input" ? "Which target?" : "Finished.",
        question: status === "needs-input" ? "Which target?" : undefined,
        completedAt: now, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      };
      writeJson(join(job.run, "result.json"), result);
      writeJson(join(job.run, "activity.json"), {
        status: "waiting", detail: status === "needs-input" ? "clarification" : "finished",
        waitingFor: status === "needs-input" ? "clarification" : "release",
        since: now, updatedAt: now, pid: process.pid, keepOpen: live,
      } satisfies Activity);
      if (!live) {
        writeJson(join(job.run, "exit.json"), { exitCode: 0 });
        tmux.kill(job.paneId!);
      }
      return result;
    },
    get now() { return now; },
  };
}

test("readActivity tolerates missing and malformed heartbeat snapshots", (t) => {
  const path = join(tempDirectory(t), "activity.json");
  assert.equal(readActivity(path), undefined);
  writeFileSync(path, "not JSON");
  assert.equal(readActivity(path), undefined);
  const valid: Activity = { status: "active", detail: "bash", since: 10, updatedAt: 20, pid: process.pid, keepOpen: false };
  for (const invalid of [null, [], {}, { ...valid, status: "done" }, { ...valid, detail: 1 },
    { ...valid, updatedAt: "20" }, { ...valid, updatedAt: null }, { ...valid, pid: 0 },
    { ...valid, pid: -1 }, { ...valid, pid: 1.5 }, { ...valid, pid: "1" }]) {
    writeJson(path, invalid);
    assert.equal(readActivity(path), undefined, JSON.stringify(invalid));
  }
  writeJson(path, valid);
  assert.deepEqual(readActivity(path), valid);
  const { since: _since, ...legacy } = valid;
  writeJson(path, legacy);
  assert.deepEqual(readActivity(path), legacy, "pre-since snapshots remain readable");
});

test("heartbeatHealth defaults to a 60 second grace period and allows a deterministic threshold", () => {
  assert.equal(STALE_HEARTBEAT_MS, 60_000);
  assert.equal(heartbeatHealth(1000, 60_999), "healthy");
  assert.equal(heartbeatHealth(1000, 61_000), "healthy");
  assert.equal(heartbeatHealth(1000, 61_001), "stalled");
  assert.equal(heartbeatHealth(1000, 1001, 0), "stalled");
  assert.equal(heartbeatHealth(1000, 1200, 200), "healthy");
  assert.equal(heartbeatHealth(1000, 1201, 200), "stalled");
  assert.equal(heartbeatHealth(1000, 900), "healthy", "a future snapshot does not create a false stall");
});

test("formatDuration clamps negative time and formats second, minute, and hour boundaries", () => {
  for (const [ms, expected] of [[-1, "0s"], [0, "0s"], [999, "0s"], [1000, "1s"],
    [59_999, "59s"], [60_000, "1m 0s"], [61_999, "1m 1s"],
    [3_599_999, "59m 59s"], [3_600_000, "1h 0m"], [7_260_000, "2h 1m"]] as const) {
    assert.equal(formatDuration(ms), expected);
  }
});

test("a live worker without a heartbeat gets startup grace, then becomes stalled without becoming an error", (t) => {
  const h = setup(t);
  h.manager.refresh();
  assert.equal(h.job.health, "healthy");
  assert.equal(h.job.status, "starting");
  h.advance(1000);
  h.manager.refresh();
  assert.deepEqual(h.alerts, []);
  h.advance(1);
  h.manager.refresh();
  h.manager.refresh();
  assert.equal(h.job.health, "stalled");
  assert.equal(h.job.status, "starting", "health must not replace task status");
  assert.deepEqual(h.results, []);
  assert.deepEqual(h.alerts, [{ name: h.job.name, transition: "stalled" }]);
  const row = h.manager.list()[0];
  assert.equal(row.live, true);
  assert.equal(row.health, "stalled");
  assert.equal(row.heartbeatAgeMs, 1001);
});

test("fresh heartbeat snapshots classify the worker as healthy", (t) => {
  const h = setup(t);
  h.advance(3000);
  h.heartbeat();
  h.manager.refresh();
  assert.equal(h.job.status, "active");
  assert.equal(h.job.health, "healthy");
  assert.equal(h.job.lastHeartbeatAt, h.now);
  assert.deepEqual(h.alerts, []);
});

test("a corrupt heartbeat is a monitoring failure and uses the last good heartbeat, not a fake exit", (t) => {
  const h = setup(t);
  h.heartbeat();
  h.manager.refresh();
  const lastGood = h.job.lastHeartbeatAt;
  h.advance(600);
  writeFileSync(join(h.job.run, "activity.json"), "{broken");
  assert.doesNotThrow(() => h.manager.refresh());
  assert.equal(h.job.health, "healthy");
  assert.equal(h.job.lastHeartbeatAt, lastGood);
  h.advance(401);
  assert.doesNotThrow(() => h.manager.list());
  assert.equal(h.job.health, "stalled");
  assert.equal(h.job.status, "active");
  assert.deepEqual(h.results, []);
  h.heartbeat();
  h.manager.refresh();
  assert.equal(h.job.health, "healthy");
  assert.deepEqual(h.alerts.map((alert) => alert.transition), ["stalled", "recovered"]);
});

test("corrupt startup snapshots use the same grace period as missing snapshots", (t) => {
  const h = setup(t);
  writeFileSync(join(h.job.run, "activity.json"), "invalid");
  h.manager.refresh();
  assert.equal(h.job.health, "healthy");
  h.advance(1001);
  h.manager.refresh();
  assert.equal(h.job.health, "stalled");
  assert.equal(h.job.status, "starting");
  assert.equal(h.alerts.length, 1);
});

test("long tool duration with continuing heartbeat never produces a false stall", (t) => {
  const h = setup(t);
  const since = h.now;
  for (let i = 0; i < 600; i++) {
    h.advance(500);
    h.heartbeat({ detail: "bash", since });
    h.manager.refresh();
    assert.equal(h.job.status, "active");
    assert.equal(h.job.health, "healthy");
  }
  const row = h.manager.list()[0];
  assert.equal(row.elapsedMs, 300_000);
  assert.equal(row.activityDurationMs, 300_000);
  assert.equal(row.heartbeatAgeMs, 0);
  assert.equal(row.activity, "bash");
  assert.deepEqual(h.alerts, []);
});

test("stalled and recovered notify only once per transition, including Manager reconstruction", (t) => {
  const h = setup(t);
  h.heartbeat();
  h.manager.refresh();
  h.advance(1001);
  h.manager.refresh();
  h.manager.refresh();
  assert.deepEqual(h.alerts.map((alert) => alert.transition), ["stalled"]);
  const restored = new Manager(h.options);
  restored.refresh();
  restored.list();
  assert.equal(restored.get(h.job.name).health, "stalled");
  assert.deepEqual(h.alerts.map((alert) => alert.transition), ["stalled"]);
  h.heartbeat();
  restored.refresh();
  restored.refresh();
  assert.deepEqual(h.alerts.map((alert) => alert.transition), ["stalled", "recovered"]);
  const restoredAgain = new Manager(h.options);
  restoredAgain.refresh();
  assert.equal(restoredAgain.get(h.job.name).health, "healthy");
  assert.deepEqual(h.alerts.map((alert) => alert.transition), ["stalled", "recovered"]);
  h.advance(1001);
  restoredAgain.refresh();
  assert.deepEqual(h.alerts.map((alert) => alert.transition), ["stalled", "recovered", "stalled"]);
});

for (const status of ["done", "needs-input", "error", "cancelled"] as const) {
  test(`exited ${status} tasks produce no stale or recovery alerts`, (t) => {
    const h = setup(t);
    h.heartbeat();
    h.manager.refresh();
    h.advance(500);
    h.complete(status);
    h.manager.refresh();
    h.advance(10_000);
    h.manager.refresh();
    const restored = new Manager(h.options);
    restored.refresh();
    assert.equal(restored.get(h.job.name).status, status);
    assert.equal(restored.get(h.job.name).health, undefined);
    const row = restored.list()[0];
    assert.equal(row.live, false);
    assert.equal(row.elapsedMs, 500, "elapsed time stops at completion");
    assert.equal(row.activityDurationMs, undefined);
    assert.equal(row.heartbeatAgeMs, undefined);
    assert.equal(row.health, undefined);
    assert.equal(row.waitingFor, status === "needs-input" ? "clarification" : undefined);
    assert.deepEqual(h.alerts, []);
  });
}

test("a kept-open needs-input task with continuing heartbeats exposes clarification without stale alerts", (t) => {
  const h = setup(t);
  h.complete("needs-input", true);
  const since = h.now;
  h.manager.refresh();
  for (let i = 0; i < 20; i++) {
    h.advance(500);
    h.heartbeat({ status: "waiting", detail: "clarification", waitingFor: "clarification", since, keepOpen: true });
    h.manager.refresh();
  }
  const row = h.manager.list()[0];
  assert.equal(row.status, "needs-input");
  assert.equal(row.live, true);
  assert.equal(row.waitingFor, "clarification");
  assert.equal(row.question, "Which target?");
  assert.equal(row.activityDurationMs, 10_000);
  assert.equal(row.heartbeatAgeMs, 0);
  assert.equal(row.health, "healthy");
  assert.deepEqual(h.alerts, []);
});

test("a stale pinned clarifier alerts without changing its needs-input task status", (t) => {
  const h = setup(t);
  h.complete("needs-input", true);
  h.manager.refresh();
  h.advance(1001);
  h.manager.refresh();
  h.manager.refresh();
  const row = h.manager.list()[0];
  assert.equal(row.status, "needs-input");
  assert.equal(row.live, true);
  assert.equal(row.waitingFor, "clarification");
  assert.equal(row.question, "Which target?");
  assert.equal(row.health, "stalled");
  assert.equal(row.heartbeatAgeMs, 1001);
  assert.deepEqual(h.alerts, [{ name: h.job.name, transition: "stalled" }]);
});

test("exiting a previously stalled worker clears health without sending a false recovery", (t) => {
  const h = setup(t);
  h.heartbeat();
  h.manager.refresh();
  h.advance(1001);
  h.manager.refresh();
  h.complete("done");
  h.manager.refresh();
  assert.equal(h.job.health, undefined);
  assert.deepEqual(h.alerts.map((alert) => alert.transition), ["stalled"]);
});

test("list separates elapsed, activity, and heartbeat ages and exposes waiting reasons", (t) => {
  const h = setup(t);
  h.advance(400);
  const since = h.now;
  h.advance(300);
  h.heartbeat({ status: "waiting", detail: "Approve?", since, waitingFor: "human-input" });
  h.advance(200);
  const row = h.manager.list()[0];
  assert.equal(row.elapsedMs, 900);
  assert.equal(row.activityDurationMs, 500);
  assert.equal(row.heartbeatAgeMs, 200);
  assert.equal(row.waitingFor, "human-input");
  assert.equal(row.health, "healthy");
  for (const waitingFor of ["inspection", "release"] as const) {
    h.heartbeat({ status: "waiting", detail: waitingFor, since, waitingFor });
    assert.equal(h.manager.list()[0].waitingFor, waitingFor);
  }
});

test("list falls back to legacy updatedAt when since is absent and clamps future snapshot ages", (t) => {
  const h = setup(t);
  h.advance(500);
  h.heartbeat({ since: undefined });
  h.advance(100);
  assert.equal(h.manager.list()[0].activityDurationMs, 100);
  h.heartbeat({ since: h.now + 100, updatedAt: h.now + 100 });
  const row = h.manager.list()[0];
  assert.equal(row.activityDurationMs, 0);
  assert.equal(row.heartbeatAgeMs, 0);
  assert.equal(row.health, "healthy");
});
