import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHILD_ENV, readJson, runFile, uniqueName, writeJson, type Completion, type Control, type Job, type Launch, type Loadout, type SpawnOptions } from "./shared.ts";
import { piInvocation, quote, Tmux, type Pane } from "./tmux.ts";
import { heartbeatHealth, readActivity } from "./health.ts";
import { renderPreloadedSkills } from "./skills.ts";
import { createWorktree, diffWorktree, integrateWorktree, removeWorktree } from "./worktrees.ts";

// Unknown/custom tools are conservatively treated as editing-capable. This is a
// workflow default, not a permission boundary; callers can explicitly choose shared.
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "ask_question", "web_search", "web_fetch", "pdf_inspect", "pdf_search", "pdf_read", "pdf_render"]);

export interface WorktreeResult {
  state: "integrated" | "discarded";
  parentRoot: string;
  path: string;
  cleanupError?: string;
}

interface Registry { version: 1; jobs: Job[] }
export interface ManagerOptions {
  directory: string;
  parentPane: string;
  extensionPath: string;
  maxConcurrent: number;
  tmux?: Tmux;
  invocation?: (args: string[]) => string[];
  onResult: (job: Job, result: Completion) => void;
  onHealth?: (job: Job, transition: "stalled" | "recovered") => void;
  staleAfterMs?: number;
  now?: () => number;
}

export class Manager {
  readonly jobs = new Map<string, Job>();
  private tmux: Tmux;
  private registryFile: string;
  private mailSequence = 0;

  constructor(private options: ManagerOptions) {
    this.tmux = options.tmux ?? new Tmux();
    this.registryFile = join(options.directory, "registry.json");
    const registry = readJson<Registry>(this.registryFile);
    if (registry) {
      if (registry.version !== 1 || !Array.isArray(registry.jobs)) throw new Error(`Unsupported registry: ${this.registryFile}`);
      for (const job of registry.jobs) this.jobs.set(job.name, job);
    }
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private save(): void { writeJson(this.registryFile, { version: 1, jobs: [...this.jobs.values()] } satisfies Registry); }
  private mailbox(job: Job): string { return join(job.directory, "mailbox"); }
  private hasMail(job: Job): boolean { return readdirSync(this.mailbox(job)).some((name) => name.endsWith(".json")); }
  private clearMail(job: Job): void {
    for (const file of readdirSync(this.mailbox(job)).filter((name) => name.endsWith(".json"))) unlinkSync(join(this.mailbox(job), file));
  }
  private deliver(job: Job, result: Completion, file: string): void {
    if (job.deliveredResults?.includes(result.id)) return;
    job.result = result;
    job.resultFile = file;
    (job.deliveredResults ??= []).push(result.id);
    // Save before notifying so reloads do not repeatedly wake the parent.
    this.save();
    this.options.onResult(job, result);
  }
  private reportFailure(job: Job, text: string, sessionFile?: string): void {
    const failure: Completion = {
      id: randomUUID(), status: "error", completedAt: this.now(), text, sessionFile,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    };
    const file = runFile(job, "result.json");
    writeJson(file, failure);
    this.deliver(job, failure, file);
  }
  private enqueue(job: Job, message: string): void {
    if (!message.trim()) throw new Error("A nonempty task/message is required.");
    // A sortable prefix preserves order even for several messages in the same millisecond.
    const name = `${Date.now()}-${String(this.mailSequence++).padStart(6, "0")}-${randomUUID()}.json`;
    writeJson(join(this.mailbox(job), name), { message });
  }
  private pane(job: Job, panes: Pane[]): Pane | undefined {
    // Ownership tag prevents killing or attaching to a reused pane after a tmux server restart.
    return panes.find((pane) => pane.paneId === job.paneId && pane.run === job.run);
  }
  private capacity(panes: Pane[]): void {
    const live = [...this.jobs.values()].filter((job) => this.pane(job, panes) && !this.pane(job, panes)!.dead).length;
    if (live >= this.options.maxConcurrent) throw new Error(`Subagent limit reached (${live}/${this.options.maxConcurrent}). Release or cancel a worker before spawning another.`);
  }

  private assertRetained(job: Job): void {
    if (job.worktree && job.worktree.state !== "retained") {
      throw new Error(`'${job.name}' was ${job.worktree.state}; its checkout is closed. Start a new task for further work. Saved session: ${job.result?.sessionFile ?? "not saved"}`);
    }
  }

  private startRun(job: Job, keepOpen: boolean, inspection = false): void {
    this.assertRetained(job);
    const run = join(job.directory, "runs", randomUUID());
    mkdirSync(run, { recursive: true, mode: 0o700 });
    const launch: Launch = {
      name: job.name, sessionId: job.sessionId, loadout: job.loadout,
      parentPane: this.options.parentPane, mailbox: this.mailbox(job), inspection,
      inspectionStatus: inspection ? job.status : undefined,
      isolation: job.worktree ? "worktree" : "shared",
    };
    writeJson(join(run, "launch.json"), launch);
    writeJson(join(run, "control.json"), { keepOpen } satisfies Control);
    if (inspection && job.status === "needs-input" && job.result?.status === "needs-input" && job.result.question) {
      writeJson(join(run, "question.json"), { question: job.result.question });
    }
    const promptFile = join(job.directory, "system-prompt.md");
    const isolation = job.worktree
      ? `You have an isolated Git worktree at ${job.worktree.path}, on task branch ${job.worktree.branch}, starting from a fixed '${job.worktree.baseline}' baseline. Work only in this checkout and on this task branch; do not edit the parent checkout (${job.worktree.parentRoot}) or other branches. Do not use the shared Git stash, change repository-wide Git configuration, or push task branches/private snapshot refs. Leave your changes here; the parent will explicitly review and integrate only your delta against the baseline. Ignored dependencies and build outputs are not copied. This is file isolation, not a sandbox: external services, ports, databases and caches may be shared. Report shared-resource needs to the parent before using them. Avoid unrelated edits.`
      : "You share the working tree with the parent; avoid unrelated edits and coordinate concurrent writes.";
    writeFileSync(promptFile, `${job.loadout.systemPrompt}\n\n${renderPreloadedSkills(job.loadout.skills)}\n\nYou are the ${job.name} subagent. Complete the delegated task and end with a concise, useful result. Your final response will be returned to the parent. If missing requirements or a material decision block your work, call ask_question alone and stop instead of guessing. The parent will answer by resuming your saved conversation. ${isolation}\n`, { mode: 0o600 });
    const args = [
      "--session-id", job.sessionId, "--session-dir", join(job.directory, "sessions"),
      "--name", `subagent:${job.name}`, "--no-extensions", "--no-prompt-templates",
      "-e", this.options.extensionPath,
      "--tools", [...new Set([...job.loadout.tools, "ask_question"])].join(","), "--thinking", job.loadout.thinking,
      "--append-system-prompt", promptFile,
      job.loadout.approveProject ? "--approve" : "--no-approve",
    ];
    if (job.loadout.model) args.push("--model", job.loadout.model);
    for (const extension of job.loadout.extensions) {
      if (extension !== this.options.extensionPath) args.push("-e", extension);
    }
    const invocation = (this.options.invocation ?? piInvocation)(args);
    const exitFile = join(run, "exit.json");
    const script = join(run, "launch.sh");
    // Launch directly as the window command. No interactive-shell startup or send-keys delays.
    // Keep the wrapper alive to capture failures that happen before the child extension can load.
    writeFileSync(script, [
      "#!/bin/bash", "umask 077",
      `env ${quote(`${CHILD_ENV}=${run}`)} ${invocation.map(quote).join(" ")}`,
      "status=$?",
      `printf '{"exitCode":%s}\\n' "$status" > ${quote(`${exitFile}.tmp`)}`,
      `mv -- ${quote(`${exitFile}.tmp`)} ${quote(exitFile)}`,
      "exit \"$status\"", "",
    ].join("\n"), { mode: 0o700 });
    job.run = run;
    job.status = "starting";
    job.startedAt = this.now();
    job.finishedAt = undefined;
    job.lastHeartbeatAt = undefined;
    job.health = undefined;
    job.windowId = undefined;
    job.paneId = undefined;
    this.save();
    try {
      const surface = this.tmux.create(this.options.parentPane, job.name, job.loadout.cwd, script, run);
      Object.assign(job, surface);
      this.save();
    } catch (error) {
      job.status = "error";
      this.save();
      throw error;
    }
  }

  spawn(loadout: Loadout, task: string, name = loadout.agent, keepOpen = false, options: SpawnOptions = {}): Job {
    if (!task.trim()) throw new Error("A nonempty task is required.");
    if (options.isolation !== undefined && !["worktree", "shared"].includes(options.isolation)) throw new Error("isolation must be worktree or shared.");
    if (options.baseline !== undefined && !["head", "current"].includes(options.baseline)) throw new Error("baseline must be head or current.");
    if (options.isolation === "shared" && options.baseline !== undefined) throw new Error("baseline applies only to worktree isolation.");
    this.refresh();
    this.capacity(this.tmux.panes());
    const id = randomUUID();
    const job: Job = {
      id, sessionId: randomUUID(), name: uniqueName(name, this.jobs.keys()),
      directory: join(this.options.directory, id), loadout: structuredClone(loadout), run: "", task,
      startedAt: this.now(), status: "starting",
    };
    const isolated = options.isolation === "worktree" || (options.isolation !== "shared" &&
      (options.baseline !== undefined || loadout.tools.some((tool) => !READ_ONLY_TOOLS.has(tool))));
    if (isolated) {
      job.worktree = createWorktree(loadout.cwd, job.directory, id, options.baseline ?? "head");
      job.loadout.cwd = job.worktree.cwd;
      // A new checkout can contain different project resources, especially at HEAD.
      // Do not extend the parent's project approval to this new directory.
      job.loadout.approveProject = false;
    }
    this.jobs.set(job.name, job);
    mkdirSync(this.mailbox(job), { recursive: true, mode: 0o700 });
    this.enqueue(job, task);
    this.startRun(job, keepOpen);
    return job;
  }

  get(name: string): Job {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`Unknown subagent '${name}'. Known names: ${[...this.jobs.keys()].join(", ") || "none"}`);
    return job;
  }

  message(name: string, message: string): Job {
    if (!message.trim()) throw new Error("A nonempty message is required.");
    this.refresh();
    const job = this.get(name);
    this.assertRetained(job);
    const panes = this.tmux.panes();
    const pane = this.pane(job, panes);
    if (!pane || pane.dead) {
      this.capacity(panes);
      this.enqueue(job, message);
      this.startRun(job, false);
    } else this.enqueue(job, message);
    return job;
  }

  async open(name: string): Promise<Job> {
    this.refresh();
    const job = this.get(name);
    this.assertRetained(job);
    const deadline = Date.now() + 15000;
    let openedFresh = false;
    while (Date.now() < deadline) {
      const panes = this.tmux.panes();
      const pane = this.pane(job, panes);
      if (!pane || pane.dead) {
        if (openedFresh) throw new Error(`Could not open '${name}': ${job.result?.text ?? "worker exited during startup"}`);
        if (!job.result?.sessionFile || !existsSync(job.result.sessionFile)) throw new Error(`No saved Pi session to inspect for '${name}'.`);
        this.capacity(panes);
        this.startRun(job, true, true);
        openedFresh = true;
      } else {
        writeJson(runFile(job, "control.json"), { keepOpen: true } satisfies Control);
        // Wait for the child to acknowledge the pin. If auto-exit already started, wait
        // for the old process to disappear and reopen its saved session, never two writers.
        if (readActivity(runFile(job, "activity.json"))?.keepOpen) {
          this.tmux.open(job.paneId!);
          return job;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      this.refresh();
    }
    throw new Error(`Timed out waiting for '${name}' to open. Inspect /subagents list or its launch artifacts: ${job.run}`);
  }

  release(name: string): void {
    const job = this.get(name);
    this.assertRetained(job);
    writeJson(runFile(job, "control.json"), { keepOpen: false } satisfies Control);
  }

  async cancel(name: string): Promise<void> {
    const job = this.get(name);
    let pane = this.pane(job, this.tmux.panes());
    if (!pane || pane.dead) {
      if (this.hasMail(job) || job.status === "needs-input") job.status = "cancelled";
      this.clearMail(job);
      this.save();
      return;
    }
    writeJson(runFile(job, "control.json"), { keepOpen: false, cancel: true } satisfies Control);
    job.status = "cancelled";
    this.save();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      pane = this.pane(job, this.tmux.panes());
      if (!pane || pane.dead) break;
    }
    if (pane) this.tmux.kill(pane.paneId);
    job.status = "cancelled";
    // Remove pending tasks so cancellation cannot race into an automatic restart.
    this.clearMail(job);
    this.save();
    this.refresh();
  }

  private isolatedJob(name: string): Job & { worktree: NonNullable<Job["worktree"]> } {
    this.refresh();
    const job = this.get(name);
    if (!job.worktree) throw new Error(`'${name}' uses a shared checkout; there is no isolated result to integrate or discard.`);
    return job as Job & { worktree: NonNullable<Job["worktree"]> };
  }

  private assertStopped(job: Job): void {
    const pane = this.pane(job, this.tmux.panes());
    if (pane && !pane.dead) throw new Error(`'${job.name}' is still open. Release it and wait for exit, or cancel it before reviewing/integrating/discarding its checkout.`);
    if (this.hasMail(job)) throw new Error(`'${job.name}' has queued messages. Cancel it before finalizing its checkout.`);
  }

  diff(name: string): { patch: string; file: string } {
    const job = this.isolatedJob(name);
    this.assertRetained(job);
    this.assertStopped(job);
    const patch = diffWorktree(job.worktree);
    const file = join(job.directory, "worker.patch");
    writeFileSync(file, patch, { mode: 0o600 });
    return { patch, file };
  }

  private cleanup(job: Job & { worktree: NonNullable<Job["worktree"]> }): WorktreeResult {
    try {
      removeWorktree(job.worktree);
      job.worktreeCleanupError = undefined;
    } catch (error) {
      job.worktreeCleanupError = error instanceof Error ? error.message : String(error);
    }
    this.save();
    return { state: job.worktree.state as WorktreeResult["state"], parentRoot: job.worktree.parentRoot,
      path: job.worktree.path, cleanupError: job.worktreeCleanupError };
  }

  integrate(name: string): WorktreeResult {
    const job = this.isolatedJob(name);
    this.assertStopped(job);
    if (job.worktree.state === "discarded") throw new Error(`'${name}' was discarded.`);
    if (job.worktree.state === "retained") {
      // Keep the review artifact even after the checkout has been removed.
      this.diff(name);
      integrateWorktree(job.worktree);
      job.worktree.state = "integrated";
      job.worktreeFinalizedAt = this.now();
      // Persist closure before destructive cleanup; retrying never reapplies changes.
      this.save();
    }
    return this.cleanup(job);
  }

  discard(name: string): WorktreeResult {
    const job = this.isolatedJob(name);
    this.assertStopped(job);
    if (job.worktree.state === "retained") {
      job.worktree.state = "discarded";
      job.worktreeFinalizedAt = this.now();
      this.save();
    }
    return this.cleanup(job);
  }

  refresh(): void {
    if (!this.jobs.size) return;
    const panes = this.tmux.panes();
    const now = this.now();
    let changed = false;
    const restart: Job[] = [];
    for (const job of this.jobs.values()) {
      if (job.worktree && job.worktree.state !== "retained") continue;
      const pane = this.pane(job, panes);
      let result = readJson<Completion>(runFile(job, "result.json"));
      const outbox = runFile(job, "results");
      if (existsSync(outbox)) {
        for (const name of readdirSync(outbox).filter((name) => name.endsWith(".json")).sort()) {
          const file = join(outbox, name);
          const completion = readJson<Completion>(file);
          if (completion) {
            this.deliver(job, completion, file);
            if (!result || completion.completedAt >= result.completedAt) result = completion;
          }
        }
      }
      const activity = readActivity(runFile(job, "activity.json"));
      const exit = readJson<{ exitCode: number }>(runFile(job, "exit.json"));
      if (result) this.deliver(job, result, runFile(job, "result.json"));
      const before = job.status;
      const inspectionLaunch = !result ? readJson<Launch>(runFile(job, "launch.json")) : undefined;
      const inspectionExit = !result && exit?.exitCode === 0 && inspectionLaunch?.inspection;
      const cancelling = readJson<Control>(runFile(job, "control.json"))?.cancel;
      if (cancelling) job.status = "cancelled";
      else if (pane && !pane.dead && !exit) {
        // Merely inspecting history must not reactivate an explicitly cancelled task.
        job.status = inspectionLaunch?.inspectionStatus === "cancelled" && activity?.waitingFor === "inspection" ? "cancelled" :
          activity?.waitingFor === "clarification" && job.result?.status === "needs-input" ? "needs-input" : activity?.status ?? job.status;
        if (activity && job.lastHeartbeatAt !== activity.updatedAt) {
          job.lastHeartbeatAt = activity.updatedAt;
          changed = true;
        }
        const health = heartbeatHealth(job.lastHeartbeatAt ?? job.startedAt, now, this.options.staleAfterMs);
        const beforeHealth = job.health;
        job.health = health;
        changed ||= beforeHealth !== health;
        if (health !== beforeHealth && (health === "stalled" || beforeHealth === "stalled")) {
          // Persist transition state before waking the parent, avoiding repeated reload alerts.
          this.save();
          this.options.onHealth?.(job, health === "stalled" ? "stalled" : "recovered");
        }
      } else {
        if (pane?.dead) this.tmux.kill(pane.paneId);
        if (job.status !== "cancelled") {
          if (inspectionExit) job.status = inspectionLaunch?.inspectionStatus ?? job.result?.status ?? "done";
          else if (result && (exit?.exitCode === 0 || activity?.status === "waiting")) job.status = result.status;
          else if (exit || !pane) job.status = "error";
        }
        if (!inspectionExit && job.status === "error" && (!result || result.status !== "error") && before !== "error") {
          this.reportFailure(job, `Worker exited unexpectedly${exit ? ` (exit ${exit.exitCode})` : " (tmux pane disappeared)"}. Launch artifacts: ${job.run}`, activity?.sessionFile);
        }
        // A steering message can arrive just as an auto-exiting worker shuts down.
        // Durable mail survives that race and resumes the same session, never a second writer.
        if (["done", "needs-input"].includes(job.status) && this.hasMail(job)) restart.push(job);
      }
      if ((!pane || pane.dead || exit) && job.finishedAt === undefined) {
        job.finishedAt = result && result.completedAt >= job.startedAt ? result.completedAt : now;
        changed = true;
      }
      if ((!pane || pane.dead || exit || cancelling) && job.health !== undefined) {
        job.health = undefined;
        changed = true;
      }
      changed ||= before !== job.status;
    }
    if (changed) this.save();
    for (const job of restart) {
      try { this.capacity(this.tmux.panes()); }
      catch { continue; } // Retry when a concurrency slot becomes available.
      try { this.startRun(job, false); }
      catch (error) { this.reportFailure(job, `Could not resume queued follow-up: ${error instanceof Error ? error.message : error}`, job.result?.sessionFile); }
    }
  }

  list(): Array<Record<string, unknown>> {
    this.refresh();
    const panes = this.tmux.panes();
    const now = this.now();
    return [...this.jobs.values()].map((job) => {
      const activity = readActivity(runFile(job, "activity.json"));
      const pane = this.pane(job, panes);
      const finalized = job.worktree && job.worktree.state !== "retained";
      const live = !finalized && !!pane && !pane.dead && !readJson(runFile(job, "exit.json"));
      let rssMiB: number | undefined;
      if (live && activity?.pid) {
        try {
          const match = readFileSync(`/proc/${activity.pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)\s+kB$/m);
          if (match) rssMiB = Math.round(Number(match[1]) / 1024);
        } catch { /* Memory statistics are optional and Linux-specific. */ }
      }
      return {
        name: job.name, agent: job.loadout.agent, status: finalized ? job.worktree!.state : job.status, live,
        activity: live ? activity?.detail : undefined,
        elapsedMs: Math.max(0, (job.finishedAt ?? now) - job.startedAt),
        activityDurationMs: live && activity ? Math.max(0, now - (activity.since ?? activity.updatedAt)) : undefined,
        health: live ? job.health : undefined,
        heartbeatAgeMs: live ? Math.max(0, now - (job.lastHeartbeatAt ?? job.startedAt)) : undefined,
        waitingFor: !finalized && job.status === "needs-input" ? "clarification" : live ? activity?.waitingFor : undefined,
        question: !finalized && job.status === "needs-input" ? job.result?.question ?? job.result?.text : undefined,
        keepOpen: live ? readJson<Control>(runFile(job, "control.json"))?.keepOpen : false,
        pid: live ? activity?.pid : undefined, rssMiB,
        pane: live ? job.paneId : undefined, cwd: job.loadout.cwd,
        sessionFile: activity?.sessionFile ?? job.result?.sessionFile,
        resultFile: job.resultFile,
        isolation: job.worktree ? "worktree" : "shared",
        worktree: job.worktree,
        worktreeFinalizedAt: job.worktreeFinalizedAt,
        worktreeCleanupError: job.worktreeCleanupError,
      };
    });
  }
}
