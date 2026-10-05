import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createWorktree, diffWorktree, integrateWorktree, removeWorktree, type Baseline, type Worktree } from "../src/worktrees.ts";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function setup(t: test.TestContext, rootName = "parent repo") {
  const dir = mkdtempSync(join(tmpdir(), "pi-worktrees-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, rootName);
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.org");
  writeFileSync(join(root, ".gitignore"), "ignored*\n");
  writeFileSync(join(root, "shared.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n");
  writeFileSync(join(root, "staged.txt"), "original\n");
  writeFileSync(join(root, "untouched.txt"), "original\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "Initial");
  let n = 0;
  const create = (baseline: Baseline = "current", cwd = root) => createWorktree(cwd, join(dir, `task ${++n}`), `test-${n}`, baseline);
  const index = () => readFileSync(join(root, ".git", "index"));
  return { dir, root, create, index };
}
const file = (w: Worktree, name: string) => join(w.path, name);

test("current snapshot isolates staged, unstaged and nonignored untracked files without changing parent", (t) => {
  const { root, create, index } = setup(t);
  writeFileSync(join(root, "staged.txt"), "staged\n");
  git(root, "add", "staged.txt");
  writeFileSync(join(root, "staged.txt"), "staged plus unstaged\n");
  writeFileSync(join(root, "new space.txt"), "untracked\n");
  writeFileSync(join(root, "ignored-staged.txt"), "staged ignored\n");
  git(root, "add", "-f", "ignored-staged.txt");
  writeFileSync(join(root, "ignored-staged.txt"), "dirty staged ignored\n");
  writeFileSync(join(root, "ignored-local.txt"), "never copied\n");
  const before = index(), head = git(root, "rev-parse", "HEAD"), branch = git(root, "symbolic-ref", "HEAD");
  const w = create();
  assert.equal(readFileSync(file(w, "staged.txt"), "utf8"), "staged plus unstaged\n");
  assert.equal(readFileSync(file(w, "new space.txt"), "utf8"), "untracked\n");
  assert.equal(readFileSync(file(w, "ignored-staged.txt"), "utf8"), "dirty staged ignored\n");
  assert.equal(existsSync(file(w, "ignored-local.txt")), false);
  assert.deepEqual(index(), before);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(git(root, "symbolic-ref", "HEAD"), branch);
  assert.equal(git(root, "rev-list", "--count", w.baselineCommit), "1");
  assert.equal(diffWorktree(w), "");
  removeWorktree(w);
  removeWorktree(w);
  assert.equal(existsSync(w.path), false);
  assert.equal(git(root, "for-each-ref", "--format=%(refname)", "refs/pi-subagents", "refs/heads/pi-subagents"), "");
});

test("current snapshot excludes formerly tracked files removed from index and now ignored", (t) => {
  const { root, create, index } = setup(t);
  writeFileSync(join(root, "secret.env"), "sensitive local data\n");
  git(root, "add", "secret.env"); git(root, "commit", "-qm", "Formerly tracked secret");
  git(root, "rm", "--cached", "secret.env");
  writeFileSync(join(root, ".gitignore"), "ignored*\nsecret.env\n");
  const before = index();
  const staged = git(root, "diff", "--cached", "--name-status");
  assert.match(staged, /D\s+secret.env/);
  const w = create("current");
  assert.equal(existsSync(file(w, "secret.env")), false);
  assert.equal(git(w.path, "ls-files", "secret.env"), "");
  assert.equal(diffWorktree(w), "");
  integrateWorktree(w);
  assert.equal(readFileSync(join(root, "secret.env"), "utf8"), "sensitive local data\n");
  assert.deepEqual(index(), before);
  assert.equal(git(root, "diff", "--cached", "--name-status"), staged);
  removeWorktree(w);
});

test("an existing linked parent checkout retains its exact staging and leaves the main checkout untouched", (t) => {
  const { dir, root, index } = setup(t);
  const linked = join(dir, "linked parent");
  git(root, "worktree", "add", "-b", "linked-parent", linked);
  writeFileSync(join(root, "staged.txt"), "main staged\n"); git(root, "add", "staged.txt");
  writeFileSync(join(root, "untouched.txt"), "main dirty\n");
  const mainIndex = index(), mainHead = git(root, "rev-parse", "HEAD");
  writeFileSync(join(linked, "staged.txt"), "linked staged\n"); git(linked, "add", "staged.txt");
  writeFileSync(join(linked, "staged.txt"), "linked staged plus dirty\n");
  writeFileSync(join(linked, "linked-untracked"), "linked baseline\n");
  const linkedIndexPath = resolve(linked, git(linked, "rev-parse", "--git-path", "index"));
  const initialLinkedIndex = readFileSync(linkedIndexPath);
  const w = createWorktree(linked, join(dir, "linked task"), "linked", "current");
  assert.equal(w.parentRoot, linked);
  assert.equal(readFileSync(file(w, "staged.txt"), "utf8"), "linked staged plus dirty\n");
  assert.equal(readFileSync(file(w, "linked-untracked"), "utf8"), "linked baseline\n");
  assert.deepEqual(readFileSync(linkedIndexPath), initialLinkedIndex);
  assert.deepEqual(index(), mainIndex);
  writeFileSync(file(w, "shared.txt"), readFileSync(file(w, "shared.txt"), "utf8").replace("one", "worker one"));
  writeFileSync(file(w, "staged.txt"), "worker edits linked dirty content\n");
  writeFileSync(join(linked, "shared.txt"), readFileSync(join(linked, "shared.txt"), "utf8").replace("nine", "linked nine"));
  git(linked, "add", "shared.txt");
  const beforeLinkedIndex = readFileSync(linkedIndexPath);
  const linkedHead = git(linked, "rev-parse", "HEAD");
  integrateWorktree(w);
  assert.match(readFileSync(join(linked, "shared.txt"), "utf8"), /worker one[\s\S]*linked nine/);
  assert.equal(readFileSync(join(linked, "staged.txt"), "utf8"), "worker edits linked dirty content\n");
  assert.deepEqual(readFileSync(linkedIndexPath), beforeLinkedIndex);
  assert.equal(git(linked, "rev-parse", "HEAD"), linkedHead);
  removeWorktree(w);
  assert.deepEqual(readFileSync(linkedIndexPath), beforeLinkedIndex);
  assert.deepEqual(index(), mainIndex);
  assert.equal(git(root, "rev-parse", "HEAD"), mainHead);
  assert.equal(readFileSync(join(root, "staged.txt"), "utf8"), "main staged\n");
  assert.equal(readFileSync(join(root, "untouched.txt"), "utf8"), "main dirty\n");
  assert.equal(readFileSync(join(root, "shared.txt"), "utf8").startsWith("one\n"), true);
});

test("parent checkout replaced by a symlink to another checkout of the same repo is refused", (t) => {
  const { dir, root, create } = setup(t);
  const alternate = join(dir, "alternate parent");
  git(root, "worktree", "add", "-b", "alternate", alternate);
  const w = create();
  writeFileSync(file(w, "untouched.txt"), "worker\n");
  const moved = join(dir, "moved parent");
  renameSync(root, moved);
  symlinkSync(alternate, root);
  try {
    assert.throws(() => diffWorktree(w), /Parent checkout path ownership mismatch/);
    assert.throws(() => integrateWorktree(w), /Parent checkout path ownership mismatch/);
    assert.throws(() => removeWorktree(w), /Parent checkout path ownership mismatch/);
    assert.equal(existsSync(w.path), true);
    assert.equal(readFileSync(join(alternate, "untouched.txt"), "utf8"), "original\n");
  } finally {
    unlinkSync(root);
    renameSync(moved, root);
  }
  assert.equal(git(root, "rev-parse", `refs/heads/${w.branch}`), w.baselineCommit);
  removeWorktree(w);
});

test("repository paths preserve trailing whitespace and newline characters", (t) => {
  const { root, create, index } = setup(t, "parent repo \n");
  const w = create();
  assert.equal(w.parentRoot, root);
  writeFileSync(file(w, "untouched.txt"), "worker\n");
  const before = index();
  integrateWorktree(w);
  assert.equal(readFileSync(join(root, "untouched.txt"), "utf8"), "worker\n");
  assert.deepEqual(index(), before);
  removeWorktree(w);
});

test("head baseline excludes all local changes and maps a nested cwd", (t) => {
  const { root, create, index } = setup(t);
  mkdirSync(join(root, "nested dir"));
  writeFileSync(join(root, "nested dir", "tracked"), "base\n");
  git(root, "add", "."); git(root, "commit", "-qm", "nested");
  writeFileSync(join(root, "staged.txt"), "dirty\n");
  git(root, "add", "staged.txt");
  writeFileSync(join(root, "new.txt"), "untracked\n");
  const before = index();
  const w = create("head", join(root, "nested dir"));
  assert.equal(w.cwd, join(w.path, "nested dir"));
  assert.equal(readFileSync(file(w, "staged.txt"), "utf8"), "original\n");
  assert.equal(existsSync(file(w, "new.txt")), false);
  assert.deepEqual(index(), before);
  removeWorktree(w);
});

test("failed cwd mapping rolls back the allocated checkout and private refs", (t) => {
  const { dir, root, create, index } = setup(t);
  writeFileSync(join(root, "nested"), "tracked file\n");
  git(root, "add", "nested"); git(root, "commit", "-qm", "File at mapped cwd");
  unlinkSync(join(root, "nested")); mkdirSync(join(root, "nested"));
  const before = index();
  assert.throws(() => create("head", join(root, "nested")), /creation failed; allocated worktree and refs were removed/);
  assert.equal(existsSync(join(dir, "task 1", "worktree")), false);
  assert.equal(existsSync(join(dir, "task 1", "worktree-owner.json")), false);
  assert.equal(git(root, "for-each-ref", "--format=%(refname)", "refs/pi-subagents", "refs/heads/pi-subagents"), "");
  assert.equal(git(root, "worktree", "list", "--porcelain").split("worktree ").length, 2);
  assert.deepEqual(index(), before);
});

test("HEAD cwd symlink cannot redirect mkdir or the worker into an external directory", (t) => {
  const { dir, root, create, index } = setup(t);
  const external = join(dir, "external"); mkdirSync(external);
  writeFileSync(join(external, "sentinel"), "unchanged\n");
  symlinkSync(external, join(root, "nested"));
  git(root, "add", "nested"); git(root, "commit", "-qm", "Symlink at mapped cwd");
  unlinkSync(join(root, "nested")); mkdirSync(join(root, "nested"));
  mkdirSync(join(root, "nested", "deeper"));
  const before = index();
  assert.throws(() => create("head", join(root, "nested", "deeper")), /symlink ancestor/);
  assert.equal(readFileSync(join(external, "sentinel"), "utf8"), "unchanged\n");
  assert.equal(existsSync(join(external, "deeper")), false);
  assert.equal(existsSync(join(dir, "task 1", "worktree")), false);
  assert.equal(existsSync(join(dir, "task 1", "worktree-owner.json")), false);
  assert.equal(git(root, "for-each-ref", "--format=%(refname)", "refs/pi-subagents", "refs/heads/pi-subagents"), "");
  assert.deepEqual(index(), before);
});

test("integration combines commits and dirty worker edits with dirty parent, preserving exact staging", (t) => {
  const { root, create, index } = setup(t);
  writeFileSync(join(root, "staged.txt"), "already staged\n"); git(root, "add", "staged.txt");
  writeFileSync(join(root, "staged.txt"), "parent dirty staging split\n");
  writeFileSync(join(root, "parent-local"), "untracked baseline\n");
  const w = create();
  writeFileSync(file(w, "shared.txt"), readFileSync(file(w, "shared.txt"), "utf8").replace("one", "worker one"));
  git(w.path, "add", "shared.txt"); git(w.path, "commit", "-qm", "Worker commit");
  writeFileSync(file(w, "worker-only"), "uncommitted\n");
  writeFileSync(file(w, "ignored-worker"), "ignored\n");
  writeFileSync(join(root, "shared.txt"), readFileSync(join(root, "shared.txt"), "utf8").replace("nine", "parent nine"));
  git(root, "add", "shared.txt");
  writeFileSync(join(root, "untouched.txt"), "parent unstaged\n");
  const before = index(), head = git(root, "rev-parse", "HEAD");
  integrateWorktree(w);
  assert.equal(w.state, "retained", "caller owns persisted state");
  assert.match(readFileSync(join(root, "shared.txt"), "utf8"), /worker one[\s\S]*parent nine/);
  assert.equal(readFileSync(join(root, "staged.txt"), "utf8"), "parent dirty staging split\n");
  assert.equal(readFileSync(join(root, "untouched.txt"), "utf8"), "parent unstaged\n");
  assert.equal(readFileSync(join(root, "worker-only"), "utf8"), "uncommitted\n");
  assert.equal(existsSync(join(root, "ignored-worker")), false);
  assert.deepEqual(index(), before);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(existsSync(w.path), true, "integration never cleans up");
  w.state = "integrated";
  removeWorktree(w);
});

test("only worker delta is applied: untouched baseline additions/deletions are not reintroduced", (t) => {
  const { root, create } = setup(t);
  writeFileSync(join(root, "local"), "baseline untracked\n");
  const w = create();
  unlinkSync(join(root, "local"));
  writeFileSync(join(root, "staged.txt"), "parent advanced\n");
  writeFileSync(file(w, "untouched.txt"), "worker delta\n");
  integrateWorktree(w);
  assert.equal(existsSync(join(root, "local")), false);
  assert.equal(readFileSync(join(root, "staged.txt"), "utf8"), "parent advanced\n");
  assert.equal(readFileSync(join(root, "untouched.txt"), "utf8"), "worker delta\n");
  removeWorktree(w);
});

test("conflicts in any path leave all checkout files and index unchanged, and retain the worktree", (t) => {
  const { root, create, index } = setup(t);
  const w = create();
  writeFileSync(file(w, "shared.txt"), "worker conflict\n");
  writeFileSync(file(w, "staged.txt"), "otherwise applies\n");
  writeFileSync(join(root, "shared.txt"), "parent conflict\n"); git(root, "add", "shared.txt");
  writeFileSync(join(root, "shared.txt"), "parent conflict plus dirty\n");
  const before = index();
  assert.throws(() => integrateWorktree(w), /conflict/i);
  assert.equal(readFileSync(join(root, "shared.txt"), "utf8"), "parent conflict plus dirty\n");
  assert.equal(readFileSync(join(root, "staged.txt"), "utf8"), "original\n");
  assert.deepEqual(index(), before);
  assert.equal(existsSync(w.path), true);
  assert.equal(w.state, "retained");
  removeWorktree(w);
});

test("binary files, executable modes, symlinks, spaces, newlines and deletions roundtrip", (t) => {
  const { root, create, index } = setup(t);
  const w = create();
  const bytes = Buffer.from([0, 1, 255, 13, 10, 0, 200]);
  writeFileSync(file(w, "binary space\nfile"), bytes);
  writeFileSync(file(w, "executable"), "#!/bin/sh\necho test\n"); chmodSync(file(w, "executable"), 0o755);
  symlinkSync("shared.txt", file(w, "symlink space"));
  unlinkSync(file(w, "staged.txt"));
  assert.match(diffWorktree(w), /GIT binary patch/);
  assert.match(diffWorktree(w), /new file mode 100755/);
  const before = index();
  integrateWorktree(w);
  assert.deepEqual(readFileSync(join(root, "binary space\nfile")), bytes);
  assert.equal(lstatSync(join(root, "executable")).mode & 0o100, 0o100);
  assert.equal(readlinkSync(join(root, "symlink space")), "shared.txt");
  assert.equal(existsSync(join(root, "staged.txt")), false);
  assert.deepEqual(index(), before);
  removeWorktree(w);
});

test("ignored-file collisions fail apply atomically and preserve parent staging", (t) => {
  const { root, create, index } = setup(t);
  const w = create();
  writeFileSync(file(w, "ignored-collision"), "worker\n"); git(w.path, "add", "-f", "ignored-collision");
  writeFileSync(file(w, "untouched.txt"), "worker other\n");
  writeFileSync(join(root, "ignored-collision"), "parent ignored\n");
  const before = index();
  assert.throws(() => integrateWorktree(w), /failed|collision/i);
  assert.equal(readFileSync(join(root, "ignored-collision"), "utf8"), "parent ignored\n");
  assert.equal(readFileSync(join(root, "untouched.txt"), "utf8"), "original\n");
  assert.deepEqual(index(), before);
  removeWorktree(w);
});

test("a fixed baseline survives parent commits and worker history rewrites", (t) => {
  const { root, create } = setup(t);
  const w = create();
  writeFileSync(join(root, "staged.txt"), "new parent commit\n"); git(root, "add", "."); git(root, "commit", "-qm", "Parent advanced");
  git(w.path, "reset", "--hard", git(root, "rev-parse", "HEAD"));
  writeFileSync(file(w, "untouched.txt"), "worker rewrite\n");
  integrateWorktree(w);
  assert.equal(readFileSync(join(root, "staged.txt"), "utf8"), "new parent commit\n");
  assert.equal(readFileSync(join(root, "untouched.txt"), "utf8"), "worker rewrite\n");
  removeWorktree(w);
});

test("private commits need no user identity and diff/apply ignore decorative user settings", (t) => {
  const { root, create, index } = setup(t);
  git(root, "config", "--unset", "user.name");
  git(root, "config", "--unset", "user.email");
  git(root, "config", "color.ui", "always");
  git(root, "config", "diff.noprefix", "true");
  git(root, "config", "diff.mnemonicPrefix", "true");
  const w = create();
  writeFileSync(file(w, "untouched.txt"), "worker\n");
  const before = index();
  assert.match(diffWorktree(w), /diff --git a\/untouched.txt b\/untouched.txt/);
  assert.equal(diffWorktree(w).includes("\u001b"), false);
  integrateWorktree(w);
  assert.equal(readFileSync(join(root, "untouched.txt"), "utf8"), "worker\n");
  assert.deepEqual(index(), before);
  git(root, "worktree", "lock", w.path);
  assert.throws(() => removeWorktree(w), /locked/);
  assert.equal(existsSync(w.path), true);
  git(root, "worktree", "unlock", w.path);
  removeWorktree(w);
});

test("ownership and changed worker branches prevent destructive cleanup", (t) => {
  const { root, create } = setup(t);
  const w = create();
  assert.throws(() => removeWorktree({ ...w, branch: "main" }), /ownership mismatch/i);
  git(w.path, "checkout", "--detach");
  assert.throws(() => removeWorktree(w), /symbolic-ref|branch changed/);
  assert.equal(existsSync(w.path), true);
  git(w.path, "checkout", w.branch);
  w.state = "discarded";
  removeWorktree(w);
  assert.equal(git(root, "for-each-ref", "--format=%(refname)", `refs/heads/${w.branch}`), "");
  removeWorktree(w);
});

test("cleanup tolerates a manually removed worktree or already deleted branch", (t) => {
  const { root, create } = setup(t);
  const w = create();
  git(root, "worktree", "remove", "--force", w.path);
  git(root, "branch", "-D", w.branch);
  removeWorktree(w);
  removeWorktree(w);
  const other = create();
  rmSync(other.path, { recursive: true });
  removeWorktree(other);
  removeWorktree(other);
});

test("missing-checkout cleanup validates baseline ownership before deleting any branch or refs", (t) => {
  const { root, create } = setup(t);
  const w = create();
  const owner = JSON.parse(readFileSync(join(w.path, "..", "worktree-owner.json"), "utf8")) as { baselineRef: string };
  rmSync(w.path, { recursive: true });
  const parentHead = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", owner.baselineRef, parentHead);
  assert.throws(() => removeWorktree(w), /baseline ref changed/);
  assert.equal(git(root, "rev-parse", `refs/heads/${w.branch}`), w.baselineCommit);
  assert.equal(git(root, "rev-parse", owner.baselineRef), parentHead);
  git(root, "update-ref", owner.baselineRef, w.baselineCommit);
  removeWorktree(w);
});

test("repository locks, unsupported index flags and filters refuse before mutation", (t) => {
  const { root, create, index } = setup(t);
  const w = create();
  writeFileSync(file(w, "untouched.txt"), "worker\n");
  const before = index();
  writeFileSync(join(root, ".git", "index.lock"), "busy");
  assert.throws(() => integrateWorktree(w), /busy/);
  unlinkSync(join(root, ".git", "index.lock"));
  assert.deepEqual(index(), before);
  git(root, "config", "filter.custom.clean", "cat");
  assert.throws(() => integrateWorktree(w), /filters/);
  git(root, "config", "--unset", "filter.custom.clean");
  git(root, "update-index", "--skip-worktree", "staged.txt");
  assert.throws(() => integrateWorktree(w), /skip-worktree/);
  git(root, "update-index", "--no-skip-worktree", "staged.txt");
  git(root, "update-index", "--assume-unchanged", "staged.txt");
  assert.throws(() => create(), /assume-unchanged/);
  git(root, "update-index", "--no-assume-unchanged", "staged.txt");
  writeFileSync(join(root, ".gitattributes"), "*.txt filter=unknown\n");
  assert.throws(() => integrateWorktree(w), /attribute filter/);
  unlinkSync(join(root, ".gitattributes"));
  assert.equal(readFileSync(join(root, "untouched.txt"), "utf8"), "original\n");
  removeWorktree(w);
});

test("nonrepos, unborn HEAD, sparse checkout, unmerged indexes and submodules fail clearly", (t) => {
  const { dir, root, create } = setup(t);
  assert.throws(() => createWorktree(dir, join(dir, "nonrepo-task"), "n", "current"), /Git/);
  const unborn = join(dir, "unborn"); mkdirSync(unborn); git(unborn, "init", "-q");
  assert.throws(() => createWorktree(unborn, join(dir, "unborn-task"), "n", "head"), /Git/);
  assert.throws(() => createWorktree(root, join(root, "tasks"), "n", "head"), /outside/);
  git(root, "config", "core.sparseCheckout", "true");
  assert.throws(() => create(), /Sparse/);
  git(root, "config", "core.sparseCheckout", "false");
  git(root, "update-index", "--add", "--cacheinfo", `160000,${git(root, "rev-parse", "HEAD")},submodule`);
  assert.throws(() => create(), /Submodules/);
  git(root, "update-index", "--force-remove", "submodule");
  const blob = git(root, "rev-parse", "HEAD:staged.txt");
  execFileSync("git", ["update-index", "--index-info"], { cwd: root, input: `0 ${"0".repeat(40)}\tstaged.txt\n100644 ${blob} 1\tstaged.txt\n100644 ${blob} 2\tstaged.txt\n100644 ${blob} 3\tstaged.txt\n` });
  assert.throws(() => create(), /Unmerged/);
});
