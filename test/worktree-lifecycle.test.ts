import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseDelegation } from "../index.ts";
import { Manager } from "../src/manager.ts";
import { readJson, writeJson, type Job, type Loadout } from "../src/shared.ts";
import { Tmux, type Pane } from "../src/tmux.ts";

class FakeTmux extends Tmux {
  live: Pane[] = [];
  next = 0;
  failCreate = false;
  override create(_parent: string, _name: string, _cwd: string, _script: string, run: string) {
    if (this.failCreate) throw new Error("tmux launch failed");
    const n = ++this.next;
    const surface = { windowId: `@${n}`, paneId: `%${n}` };
    this.live.push({ ...surface, run, dead: false });
    return surface;
  }
  override panes() { return [...this.live]; }
  override kill(id: string) { this.live = this.live.filter((pane) => pane.paneId !== id); }
}

function setup(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "pi-worktree-lifecycle-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(repo, "file.txt"), "baseline\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  const loadout: Loadout = { agent: "worker", tools: ["read", "edit", "write", "bash"], extensions: [], systemPrompt: "Be useful.", thinking: "off", cwd: repo, approveProject: true };
  const tmux = new FakeTmux();
  const options = { directory: join(directory, "jobs"), parentPane: "%0", extensionPath: "/extension.ts", maxConcurrent: 4, tmux, invocation: () => ["pi"], onResult: () => {} };
  const manager = new Manager(options);
  const stopped = (job: Job, exitCode = 0) => {
    for (const name of readdirSync(join(job.directory, "mailbox"))) unlinkSync(join(job.directory, "mailbox", name));
    writeJson(join(job.run, "exit.json"), { exitCode });
    writeJson(join(job.run, "result.json"), { id: job.run, status: exitCode ? "error" : "done", text: "Result", completedAt: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } });
    tmux.kill(job.paneId!);
    manager.refresh();
  };
  return { directory, repo, git, loadout, tmux, options, manager, stopped };
}

test("editing workers default to HEAD worktrees; read-only workers share; overrides are explicit", (t) => {
  const { repo, manager, loadout, stopped } = setup(t);
  writeFileSync(join(repo, "file.txt"), "unfinished\n");
  const worker = manager.spawn(loadout, "Edit code");
  assert.equal(worker.worktree?.baseline, "head");
  assert.notEqual(worker.loadout.cwd, repo);
  assert.equal(readFileSync(join(worker.loadout.cwd, "file.txt"), "utf8"), "baseline\n");
  assert.equal(worker.loadout.approveProject, false);
  assert.equal(loadout.cwd, repo, "do not mutate caller's loadout");
  assert.match(readFileSync(join(worker.directory, "system-prompt.md"), "utf8"), /Do not use the shared Git stash/);
  const scout = manager.spawn({ ...loadout, tools: ["read", "grep", "find", "ls"] }, "Read code", "scout");
  assert.equal(scout.worktree, undefined);
  assert.equal(scout.loadout.cwd, repo);
  const shared = manager.spawn(loadout, "Explicit sharing", "shared", false, { isolation: "shared" });
  assert.equal(shared.worktree, undefined);
  stopped(worker);
  const snapshot = manager.spawn({ ...loadout, tools: ["read"] }, "Read unfinished code", "snapshot", false, { baseline: "current" });
  assert.equal(snapshot.worktree?.baseline, "current");
  assert.equal(readFileSync(join(snapshot.loadout.cwd, "file.txt"), "utf8"), "unfinished\n");
});

test("isolation failures never silently fall back, and invalid combinations fail before launch", (t) => {
  const { directory, manager, loadout, tmux } = setup(t);
  const nonrepo = join(directory, "nonrepo");
  mkdirSync(nonrepo);
  assert.throws(() => manager.spawn({ ...loadout, cwd: nonrepo }, "Edit"), /Git|git|repository/);
  assert.equal(manager.jobs.size, 0);
  assert.equal(tmux.live.length, 0);
  assert.throws(() => manager.spawn(loadout, "Edit", "bad", false, { isolation: "shared", baseline: "current" }), /baseline/);
  assert.equal(manager.spawn({ ...loadout, cwd: nonrepo }, "Explicit sharing", "shared", false, { isolation: "shared" }).worktree, undefined);
});

test("worktree survives completion, reload, and revisions until explicit integration", (t) => {
  const { manager, loadout, options, stopped, repo } = setup(t);
  const job = manager.spawn(loadout, "Edit", "task", false, { baseline: "current" });
  writeFileSync(join(job.loadout.cwd, "new.txt"), "worker\n");
  stopped(job);
  assert.equal(job.worktree?.state, "retained");
  assert.equal(existsSync(join(repo, "new.txt")), false);
  const restored = new Manager(options);
  const saved = restored.get(job.name);
  assert.deepEqual(saved.worktree, job.worktree);
  restored.message(job.name, "Revise");
  assert.equal(saved.loadout.cwd, job.loadout.cwd);
  assert.notEqual(saved.run, job.run);
  writeFileSync(join(saved.loadout.cwd, "new.txt"), "worker revised\n");
  stopped(saved);
  const review = restored.diff(saved.name);
  assert.match(review.patch, /worker revised/);
  assert.equal(readFileSync(review.file, "utf8"), review.patch);
  const result = restored.integrate(saved.name);
  assert.equal(result.state, "integrated");
  assert.equal(result.cleanupError, undefined);
  assert.equal(readFileSync(join(repo, "new.txt"), "utf8"), "worker revised\n");
  assert.equal(existsSync(saved.worktree!.path), false);
  assert.equal(readFileSync(review.file, "utf8"), review.patch, "keep review artifact after cleanup");
  const finalized = new Manager(options);
  finalized.refresh();
  assert.equal(finalized.get(job.name).worktree?.state, "integrated");
  assert.throws(() => finalized.message(job.name, "More edits"), /integrated/);
  assert.throws(() => finalized.diff(job.name), /integrated/);
  assert.equal(finalized.integrate(job.name).state, "integrated", "retry finalization is idempotent");
});

test("live and queued workers cannot be reviewed, integrated or discarded", async (t) => {
  const { manager, loadout, tmux } = setup(t);
  const job = manager.spawn(loadout, "Edit");
  for (const operation of ["diff", "integrate", "discard"] as const) assert.throws(() => manager[operation](job.name), /still open/);
  tmux.kill(job.paneId!);
  manager.refresh();
  assert.throws(() => manager.discard(job.name), /queued messages/);
  await manager.cancel(job.name);
  assert.equal(job.status, "cancelled");
  assert.equal(existsSync(job.worktree!.path), true, "cancel must retain partial work");
  assert.equal(manager.discard(job.name).state, "discarded");
  assert.equal(existsSync(job.worktree!.path), false);
});

test("conflicting integration preserves parent/index and retains worker work", (t) => {
  const { manager, loadout, stopped, repo } = setup(t);
  const job = manager.spawn(loadout, "Edit", "conflict", false, { baseline: "current" });
  writeFileSync(join(job.loadout.cwd, "file.txt"), "worker\n");
  stopped(job);
  writeFileSync(join(repo, "file.txt"), "parent\n");
  const indexBefore = readFileSync(join(repo, ".git", "index"));
  assert.throws(() => manager.integrate(job.name), /conflict/i);
  assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "parent\n");
  assert.deepEqual(readFileSync(join(repo, ".git", "index")), indexBefore);
  assert.equal(job.worktree?.state, "retained");
  assert.equal(existsSync(job.worktree!.path), true);
  assert.equal(manager.discard(job.name).state, "discarded");
  assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "parent\n");
  assert.throws(() => manager.integrate(job.name), /discarded/);
});

test("launch/provider failures retain worktrees and saved artifacts until discard", (t) => {
  const { manager, loadout, tmux, stopped } = setup(t);
  const failed = manager.spawn(loadout, "Fail");
  writeFileSync(join(failed.loadout.cwd, "partial.txt"), "valuable partial work\n");
  stopped(failed, 127);
  assert.equal(failed.status, "error");
  assert.equal(failed.worktree?.state, "retained");
  assert.equal(readFileSync(join(failed.loadout.cwd, "partial.txt"), "utf8"), "valuable partial work\n");
  const resultFile = failed.resultFile!;
  manager.discard(failed.name);
  assert.equal(existsSync(resultFile), true);
  tmux.failCreate = true;
  assert.throws(() => manager.spawn(loadout, "Startup failure", "launch-failed"), /tmux launch failed/);
  const startup = manager.get("launch-failed");
  assert.equal(startup.status, "error");
  assert.equal(existsSync(startup.worktree!.path), true);
});

test("cleanup failure persists closure and retry never reapplies integrated changes", (t) => {
  const { manager, loadout, stopped, repo, git, options } = setup(t);
  const job = manager.spawn(loadout, "Edit", "cleanup");
  writeFileSync(join(job.loadout.cwd, "new.txt"), "worker\n");
  stopped(job);
  git("worktree", "lock", job.worktree!.path);
  const result = manager.integrate(job.name);
  assert.equal(result.state, "integrated");
  assert.match(result.cleanupError!, /locked/);
  assert.equal(existsSync(job.worktree!.path), true);
  assert.equal(manager.list()[0].status, "integrated");
  const restored = new Manager(options);
  assert.equal(restored.get(job.name).worktree?.state, "integrated");
  assert.throws(() => restored.message(job.name, "Revise"), /integrated/);
  writeFileSync(join(repo, "new.txt"), "parent changed after integration\n");
  git("worktree", "unlock", job.worktree!.path);
  assert.equal(restored.integrate(job.name).cleanupError, undefined);
  assert.equal(readFileSync(join(repo, "new.txt"), "utf8"), "parent changed after integration\n");
  assert.equal(existsSync(job.worktree!.path), false);
  assert.equal(readJson<{ jobs: Job[] }>(join(options.directory, "registry.json"))!.jobs[0].worktreeCleanupError, undefined);
});

test("shared jobs are not eligible for isolated-result operations", (t) => {
  const { manager, loadout, stopped } = setup(t);
  const job = manager.spawn(loadout, "Shared", "shared", false, { isolation: "shared" });
  stopped(job);
  for (const operation of ["diff", "integrate", "discard"] as const) assert.throws(() => manager[operation](job.name), /shared checkout/);
});

test("delegation flags are parsed only before profile; task text stays literal", () => {
  assert.deepEqual(parseDelegation("worker Do work --baseline current"), { agent: "worker", task: "Do work --baseline current" });
  assert.deepEqual(parseDelegation("--baseline current --isolation worktree worker Do work\nwith details"), { baseline: "current", isolation: "worktree", agent: "worker", task: "Do work\nwith details" });
  assert.deepEqual(parseDelegation("--isolation shared worker Do work"), { isolation: "shared", agent: "worker", task: "Do work" });
  for (const args of ["", "worker", "--baseline invalid worker task", "--unknown worker task", "--baseline head --baseline current worker task"]) assert.throws(() => parseDelegation(args));
});
