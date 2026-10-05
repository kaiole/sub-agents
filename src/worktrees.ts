import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type Baseline = "head" | "current";
export interface Worktree {
  parentRoot: string;
  parentCwd: string;
  path: string;
  cwd: string;
  branch: string;
  baseline: Baseline;
  baselineCommit: string;
  state: "retained" | "integrated" | "discarded";
}
interface Owner { version: 1; worktree: Worktree; baselineRef: string; common: string; removed?: boolean }
const ownerFile = (w: Worktree) => join(dirname(w.path), "worktree-owner.json");
const identity = ["-c", "user.name=Pi subagent", "-c", "user.email=pi-subagent@localhost"];

/** No inherited Git redirection, hooks, external diff, shell, or optional index refreshes. */
function git(cwd: string, args: string[], input?: Buffer | string, index?: string): Buffer {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...(index ? { GIT_INDEX_FILE: index } : {}) });
  try {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.filemode=true", "-c", "color.ui=false", "-c", "apply.ignoreWhitespace=no", "-c", "merge.renormalize=false", ...identity, ...args], {
      cwd, env, input, maxBuffer: 128 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as Error & { stderr?: Buffer; stdout?: Buffer };
    throw new Error(`Git ${args[0]} failed: ${e.stderr?.toString().trim() || e.stdout?.toString().trim() || e.message}`, { cause: error });
  }
}
// Strip only Git's record terminator, not whitespace belonging to a pathname.
const text = (cwd: string, args: string[]) => git(cwd, args).toString().replace(/\n$/, "");
const gitPath = (root: string, name: string) => resolve(root, text(root, ["rev-parse", "--git-path", name]));
const commonDir = (root: string) => realpathSync(resolve(root, text(root, ["rev-parse", "--git-common-dir"])));
// --list permits missing configuration without hiding other Git errors.
function configs(root: string): string[] { return text(root, ["config", "--list"]).split("\n"); }
function preflight(root: string): void {
  if (text(root, ["rev-parse", "--is-bare-repository"]) !== "false") throw new Error("Bare repositories are unsupported.");
  text(root, ["rev-parse", "--verify", "HEAD^{commit}"]); // Unborn HEAD must fail, never fall back.
  const settings = configs(root);
  if (settings.some((s) => /^core\.sparsecheckout=(true|1|yes|on)$/i.test(s))) throw new Error("Sparse checkouts are unsupported.");
  if (settings.some((s) => /^filter\./i.test(s))) throw new Error("Custom clean/smudge filters are unsupported.");
  if (settings.some((s) => /^merge\..*\.driver=/i.test(s))) throw new Error("Custom merge drivers are unsupported.");
  if (settings.some((s) => /^core\.autocrlf=(?!false$|0$|no$|off$).+/i.test(s))) throw new Error("core.autocrlf transformations are unsupported.");
  if (settings.some((s) => /^core\.symlinks=(false|0|no|off)$/i.test(s))) throw new Error("core.symlinks=false is unsupported.");
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
    if (existsSync(gitPath(root, name))) throw new Error(`Repository operation in progress: ${name}.`);
  }
  if (git(root, ["ls-files", "--unmerged", "-z"]).length) throw new Error("Unmerged index is unsupported.");
  const flags = git(root, ["ls-files", "-v", "-z"]).toString().split("\0");
  if (flags.some((p) => /^[a-zS] /.test(p))) throw new Error("assume-unchanged/skip-worktree index entries are unsupported.");
  const staged = git(root, ["ls-files", "--stage", "-z"]);
  const head = git(root, ["ls-tree", "-r", "-z", "HEAD"]);
  if ([staged, head].some((b) => b.toString().split("\0").some((p) => p.startsWith("160000 ")))) throw new Error("Submodules are unsupported.");
  const paths = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if ([paths, staged, head].some((b) => !Buffer.from(b.toString(), "utf8").equals(b))) throw new Error("Non-UTF-8 Git filenames are unsupported.");
  const attrs = git(root, ["check-attr", "--all", "-z", "--stdin"], paths).toString().split("\0");
  for (let i = 0; i + 2 < attrs.length; i += 3) {
    if ((["filter", "working-tree-encoding", "eol", "text", "ident"].includes(attrs[i + 1]) && !["unset", "unspecified"].includes(attrs[i + 2])) ||
        (attrs[i + 1] === "merge" && !["unset", "unspecified", "set", "binary", "text"].includes(attrs[i + 2]))) {
      throw new Error(`Git attribute ${attrs[i + 1]} is unsupported (${attrs[i]}).`);
    }
  }
}
function snapshot(root: string): string {
  preflight(root);
  const dir = mkdtempSync(join(tmpdir(), "pi-worktree-index-"));
  const index = join(dir, "index");
  try {
    git(root, ["read-tree", "--empty"], undefined, index);
    // Tracking eligibility comes ONLY from the real current index. In particular,
    // staged-new ignored files remain tracked, but rm --cached + ignore must not
    // resurrect a formerly tracked (and potentially sensitive) HEAD file.
    git(root, ["update-index", "-z", "--index-info"], git(root, ["ls-files", "--stage", "-z"]), index);
    git(root, ["add", "-A", "--", "."], undefined, index);
    const tree = git(root, ["write-tree"], undefined, index).toString().trim();
    if (git(root, ["ls-tree", "-r", "-z", tree]).toString().split("\0").some((p) => p.startsWith("160000 "))) throw new Error("Embedded repositories/submodules are unsupported.");
    return tree;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function commit(root: string, tree: string, parent?: string): string {
  return git(root, ["commit-tree", tree, ...(parent ? ["-p", parent] : [])], "Private Pi worktree snapshot\n").toString().trim();
}
function indexBytes(root: string): Buffer | undefined {
  const path = gitPath(root, "index");
  return existsSync(path) ? readFileSync(path) : undefined;
}
function equal(a: Buffer | undefined, b: Buffer | undefined): boolean { return a === undefined ? b === undefined : b !== undefined && a.equals(b); }
function headToken(root: string): string { return text(root, ["rev-parse", "HEAD"]) + "\n" + text(root, ["rev-parse", "--symbolic-full-name", "HEAD"]); }
function locked<T>(root: string, action: () => T, workerRoot?: string): T {
  const locks = [join(commonDir(root), "pi-subagents-worktrees.lock"), gitPath(root, "index.lock"), ...(workerRoot ? [gitPath(workerRoot, "index.lock")] : [])];
  const held: { path: string; fd: number }[] = [];
  try {
    for (const path of locks) {
      try { held.push({ path, fd: openSync(path, "wx", 0o600) }); }
      catch (e) { throw new Error(`Repository is busy (lock ${path}); retry after the other operation finishes.`, { cause: e }); }
    }
    return action();
  } finally { for (const { path, fd } of held.reverse()) { closeSync(fd); unlinkSync(path); } }
}
function sameLocation(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(".." + "/") && rel !== ".." && !isAbsolute(rel));
}
function loadOwner(w: Worktree): Owner {
  let owner: Owner;
  try { owner = JSON.parse(readFileSync(ownerFile(w), "utf8")) as Owner; }
  catch (error) { throw new Error("Missing or invalid worktree ownership record; refusing operation.", { cause: error }); }
  if (owner.version !== 1 || !owner.worktree || !/^refs\/pi-subagents\/[a-f0-9-]+\/baseline$/.test(owner.baselineRef)) throw new Error("Invalid worktree ownership record.");
  for (const key of ["parentRoot", "parentCwd", "path", "cwd", "branch", "baseline", "baselineCommit"] as const) {
    if (owner.worktree[key] !== w[key]) throw new Error(`Worktree ownership mismatch: ${key}.`);
  }
  validateParent(w, owner);
  return owner;
}
function validateParent(w: Worktree, owner: Owner): void {
  if (realpathSync(w.parentRoot) !== w.parentRoot || text(w.parentRoot, ["rev-parse", "--show-toplevel"]) !== w.parentRoot) throw new Error("Parent checkout path ownership mismatch.");
  if (commonDir(w.parentRoot) !== owner.common) throw new Error("Worktree repository ownership mismatch.");
}
function validate(w: Worktree, owner: Owner): void {
  validateParent(w, owner);
  if (owner.removed || !existsSync(w.path)) throw new Error("Owned worktree no longer exists.");
  if (realpathSync(w.path) !== w.path || text(w.path, ["rev-parse", "--show-toplevel"]) !== w.path || commonDir(w.path) !== owner.common) throw new Error("Worktree path ownership mismatch.");
  if (text(w.path, ["symbolic-ref", "HEAD"]) !== `refs/heads/${w.branch}`) throw new Error("Worker branch changed; refusing destructive operation.");
  if (text(w.parentRoot, ["rev-parse", "--verify", owner.baselineRef]) !== w.baselineCommit) throw new Error("Private baseline ref changed.");
}
function saveOwner(w: Worktree, owner: Owner): void {
  const temp = ownerFile(w) + "." + randomUUID();
  try {
    writeFileSync(temp, JSON.stringify(owner, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, ownerFile(w));
  } finally { rmSync(temp, { force: true }); }
}

export function createWorktree(parentCwd: string, taskDirectory: string, taskId: string, baseline: Baseline): Worktree {
  if (baseline !== "head" && baseline !== "current") throw new Error("Invalid worktree baseline.");
  parentCwd = realpathSync(parentCwd);
  const parentRoot = realpathSync(text(parentCwd, ["rev-parse", "--show-toplevel"]));
  taskDirectory = resolve(taskDirectory);
  if (sameLocation(parentRoot, taskDirectory)) throw new Error("Task directory must be outside the parent checkout (avoid recursively snapshotting worker artifacts).");
  mkdirSync(taskDirectory, { recursive: true, mode: 0o700 });
  taskDirectory = realpathSync(taskDirectory);
  if (sameLocation(parentRoot, taskDirectory)) throw new Error("Task directory resolves inside the parent checkout.");
  const path = join(taskDirectory, "worktree");
  if (existsSync(path) || existsSync(join(taskDirectory, "worktree-owner.json"))) throw new Error("Task already has a worktree/ownership record.");
  return locked(parentRoot, () => {
    if (existsSync(path) || existsSync(join(taskDirectory, "worktree-owner.json"))) throw new Error("Task already has a worktree/ownership record.");
    preflight(parentRoot);
    const beforeIndex = indexBytes(parentRoot), beforeHead = headToken(parentRoot);
    const tree = baseline === "head" ? text(parentRoot, ["rev-parse", "HEAD^{tree}"]) : snapshot(parentRoot);
    if (beforeHead !== headToken(parentRoot) || !equal(beforeIndex, indexBytes(parentRoot)) || (baseline === "current" && tree !== snapshot(parentRoot))) throw new Error("Parent changed during baseline capture; retry.");
    const id = randomUUID();
    const branch = `pi-subagents/${taskId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "task"}-${id}`;
    const baselineCommit = commit(parentRoot, tree); // No parent: never enters actual branch history.
    const w: Worktree = { parentRoot, parentCwd, path, cwd: join(path, relative(parentRoot, parentCwd)), branch, baseline, baselineCommit, state: "retained" };
    const owner: Owner = { version: 1, worktree: { ...w }, baselineRef: `refs/pi-subagents/${id}/baseline`, common: commonDir(parentRoot) };
    git(parentRoot, ["update-ref", owner.baselineRef, baselineCommit, ""]);
    try {
      saveOwner(w, owner);
      git(parentRoot, ["worktree", "add", "-b", branch, path, baselineCommit]);
      // A dirty parent directory may be a symlink in the HEAD baseline. Never
      // follow it while creating the mapped cwd (nor launch outside isolation).
      let ancestor = w.cwd;
      while (true) {
        let stat;
        try { stat = lstatSync(ancestor); } catch (e) { if (!["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code!)) throw e; }
        if (stat?.isSymbolicLink()) throw new Error(`Mapped worker cwd has a symlink ancestor: ${ancestor}`);
        if (ancestor === path) break;
        ancestor = dirname(ancestor);
      }
      mkdirSync(w.cwd, { recursive: true });
      if (realpathSync(w.cwd) !== w.cwd || !sameLocation(path, realpathSync(w.cwd))) throw new Error("Mapped worker cwd escapes its worktree.");
      return w;
    } catch (error) {
      // No worker has started and the path was absent under our creation lock.
      // Roll back only this allocation, never global worktree-prune or other refs.
      try {
        const branchRef = `refs/heads/${branch}`;
        const refs = git(parentRoot, ["for-each-ref", "--format=%(refname)", branchRef, owner.baselineRef]).toString().trim().split("\n");
        if (refs.includes(owner.baselineRef) && text(parentRoot, ["rev-parse", owner.baselineRef]) !== baselineCommit) throw new Error("Allocated baseline ref changed during creation rollback.");
        if (refs.includes(branchRef) && text(parentRoot, ["rev-parse", branchRef]) !== baselineCommit) throw new Error("Allocated branch changed during creation rollback.");
        const entries = git(parentRoot, ["worktree", "list", "--porcelain", "-z"]).toString().split("\0\0");
        const entry = entries.find((e) => e.split("\0").includes(`worktree ${path}`));
        if (entry) {
          if (!entry.split("\0").includes(`branch refs/heads/${branch}`)) throw new Error("Partially created worktree has unexpected branch ownership.");
          git(parentRoot, ["worktree", "remove", "--force", path]);
        } else {
          // Git can fail after creating the directory but before registering it.
          rmSync(path, { recursive: true, force: true });
        }
        if (refs.includes(branchRef)) {
          git(parentRoot, ["branch", "-D", branch]);
        }
        if (refs.includes(owner.baselineRef)) git(parentRoot, ["update-ref", "-d", owner.baselineRef, baselineCommit]);
        rmSync(ownerFile(w), { force: true });
      } catch (cleanup) {
        try { saveOwner(w, owner); } catch { /* Error below identifies the task even if metadata cannot be saved. */ }
        throw new Error(`Worktree creation failed (${String(error)}); allocation cleanup also failed (${String(cleanup)}). Manual recovery: ${ownerFile(w)}; worktree ${path}; branch ${branch}; baseline ref ${owner.baselineRef}.`, { cause: error });
      }
      throw new Error(`Worktree creation failed; allocated worktree and refs were removed. ${String(error)}`, { cause: error });
    }
  });
}

export function diffWorktree(w: Worktree): string {
  const owner = loadOwner(w);
  validate(w, owner);
  const tree = snapshot(w.path);
  return git(w.path, ["diff", "--binary", "--full-index", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--no-renames", w.baselineCommit, tree, "--"]).toString();
}

type Backup = { path: string; kind: "missing" } | { path: string; kind: "file"; data: Buffer; mode: number } | { path: string; kind: "link"; target: string };
function backup(root: string, paths: string[]): Backup[] {
  return paths.map((name) => {
    const path = join(root, name);
    // Never traverse existing symlink parents, even when Git would reject the patch.
    let parent = dirname(path);
    while (parent !== root) {
      if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error(`Symlink parent is unsupported: ${name}`);
      parent = dirname(parent);
    }
    let stat;
    try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, kind: "missing" }; throw error; }
    if (stat.isSymbolicLink()) return { path, kind: "link", target: readlinkSync(path) };
    if (!stat.isFile()) throw new Error(`Non-file checkout collision: ${name}`);
    return { path, kind: "file", data: readFileSync(path), mode: stat.mode };
  });
}
function rollback(root: string, backups: Backup[], missingDirs: Set<string>): void {
  for (const b of backups) {
    let stat;
    try { stat = lstatSync(b.path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    // Validation failures have not written anything; do not disturb even mtimes.
    if (b.kind === "missing" && !stat) continue;
    if (b.kind === "file" && stat?.isFile() && stat.mode === b.mode && readFileSync(b.path).equals(b.data)) continue;
    if (b.kind === "link" && stat?.isSymbolicLink() && readlinkSync(b.path) === b.target) continue;
    // Preserve directories: a file/directory transition is refused in preflight.
    try { unlinkSync(b.path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (b.kind === "file") { mkdirSync(dirname(b.path), { recursive: true }); writeFileSync(b.path, b.data); chmodSync(b.path, b.mode); }
    if (b.kind === "link") { mkdirSync(dirname(b.path), { recursive: true }); symlinkSync(b.target, b.path); }
  }
  for (const dir of [...missingDirs].sort((a, b) => b.length - a.length)) {
    if (dir === root) continue;
    try { rmdirSync(dir); } catch (e) { if (!["ENOENT", "ENOTEMPTY"].includes((e as NodeJS.ErrnoException).code!)) throw e; }
  }
}

/** Integrate only the baseline-to-worker delta, leaving the real index byte-for-byte intact.
 * The index lock and double snapshots detect cooperating Git races. Editors do not honor
 * Git locks: callers must stop the worker and avoid concurrent parent file edits.
 */
export function integrateWorktree(w: Worktree): void {
  if (w.state !== "retained") throw new Error(`Cannot integrate a ${w.state} worktree.`);
  const owner = loadOwner(w);
  locked(w.parentRoot, () => {
    validate(w, owner);
    const beforeIndex = indexBytes(w.parentRoot), parentHead = headToken(w.parentRoot), workerHead = headToken(w.path);
    const parentTree = snapshot(w.parentRoot), workerTree = snapshot(w.path);
    // Both sides have the exact private baseline as their sole parent. Worker history
    // (including merges/rebases) must not alter the definition of its task delta.
    const ours = commit(w.parentRoot, parentTree, w.baselineCommit);
    const theirs = commit(w.parentRoot, workerTree, w.baselineCommit);
    let merged: string;
    try { merged = text(w.parentRoot, ["merge-tree", "--write-tree", ours, theirs]).split("\n")[0]; }
    catch (error) { throw new Error(`Worktree integration conflict; parent checkout and index are unchanged. ${String(error)}`, { cause: error }); }
    const patch = git(w.parentRoot, ["diff", "--binary", "--full-index", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--no-renames", parentTree, merged, "--"]);
    const names = git(w.parentRoot, ["diff", "--name-only", "-z", "--no-renames", parentTree, merged, "--"]).toString().split("\0").filter(Boolean);
    const backups = backup(w.parentRoot, names);
    const missingDirs = new Set<string>();
    for (const name of names) {
      let dir = dirname(join(w.parentRoot, name));
      while (dir !== w.parentRoot) { if (!existsSync(dir)) missingDirs.add(dir); dir = dirname(dir); }
    }
    validate(w, owner);
    if (!equal(beforeIndex, indexBytes(w.parentRoot)) || parentHead !== headToken(w.parentRoot) || workerHead !== headToken(w.path) || parentTree !== snapshot(w.parentRoot) || workerTree !== snapshot(w.path)) throw new Error("Checkout/index changed during integration preflight; retry.");
    if (!patch.length) return;
    try {
      // A single Git apply validates all paths before writing, with no --index/--3way.
      git(w.parentRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], patch);
      if (!equal(beforeIndex, indexBytes(w.parentRoot))) throw new Error("Parent index changed unexpectedly during integration.");
    } catch (error) {
      try { rollback(w.parentRoot, backups, missingDirs); }
      catch (recovery) { throw new Error(`Integration failed and rollback failed: ${String(recovery)}. Preserve this worktree and recover the checkout manually.`, { cause: error }); }
      throw new Error(`Integration failed; checkout restored and worktree retained. ${String(error)}`, { cause: error });
    }
  }, w.path);
  // Lifecycle state and cleanup are deliberately owned by the caller's persistence layer.
}

/** Idempotent cleanup after the caller persists integrated/discarded state. */
export function removeWorktree(w: Worktree): void {
  const owner = loadOwner(w);
  locked(w.parentRoot, () => {
    validateParent(w, owner);
    if (owner.removed) {
      if (existsSync(w.path)) throw new Error("A path appeared after worktree cleanup; refusing removal.");
      return;
    }
    const refs = git(w.parentRoot, ["for-each-ref", "--format=%(refname)", `refs/heads/${w.branch}`, owner.baselineRef]).toString().trim().split("\n");
    // Check every surviving ownership anchor before deleting anything, including
    // when the checkout itself has already disappeared during a cleanup retry.
    if (refs.includes(owner.baselineRef) && text(w.parentRoot, ["rev-parse", owner.baselineRef]) !== w.baselineCommit) throw new Error("Private baseline ref changed; refusing deletion.");
    if (existsSync(w.path)) { validate(w, owner); git(w.parentRoot, ["worktree", "remove", "--force", w.path]); }
    else {
      // Remove only our registered missing worktree, never prune unrelated worktrees.
      const entries = git(w.parentRoot, ["worktree", "list", "--porcelain", "-z"]).toString().split("\0\0");
      const entry = entries.find((e) => e.split("\0").includes(`worktree ${w.path}`));
      if (entry) {
        if (!entry.split("\0").includes(`branch refs/heads/${w.branch}`)) throw new Error("Missing worker has a different branch; refusing cleanup.");
        git(w.parentRoot, ["worktree", "remove", "--force", w.path]);
      }
    }
    if (refs.includes(`refs/heads/${w.branch}`)) {
      // branch -D also refuses a branch checked out in any other worktree.
      git(w.parentRoot, ["branch", "-D", w.branch]);
    }
    if (refs.includes(owner.baselineRef)) {
      if (text(w.parentRoot, ["rev-parse", owner.baselineRef]) !== w.baselineCommit) throw new Error("Private baseline ref changed; refusing deletion.");
      git(w.parentRoot, ["update-ref", "-d", owner.baselineRef, w.baselineCommit]);
    }
    owner.removed = true;
    saveOwner(w, owner);
  });
}
