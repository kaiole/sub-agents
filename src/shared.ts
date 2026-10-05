import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Baseline, Worktree } from "./worktrees.ts";

export const CHILD_ENV = "PI_BACKGROUND_SUBAGENT_RUN";
export const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]);
export type Status = "starting" | "active" | "waiting" | "needs-input" | "done" | "error" | "cancelled";
export type WaitingFor = "human-input" | "clarification" | "inspection" | "release";
export type Health = "healthy" | "stalled";

export interface PreloadedSkill { name: string; path: string; content: string }

export interface Loadout {
  agent: string;
  tools: string[];
  extensions: string[];
  systemPrompt: string;
  skills?: PreloadedSkill[];
  model?: string;
  thinking: ThinkingLevel;
  cwd: string;
  approveProject: boolean;
}

export interface SpawnOptions {
  isolation?: "worktree" | "shared";
  baseline?: Baseline;
}

export interface Job {
  name: string;
  id: string;
  sessionId: string;
  directory: string;
  loadout: Loadout;
  run: string;
  task: string;
  startedAt: number;
  finishedAt?: number;
  lastHeartbeatAt?: number;
  health?: Health;
  windowId?: string;
  paneId?: string;
  status: Status;
  deliveredResults?: string[];
  result?: Completion;
  resultFile?: string;
  worktree?: Worktree;
  worktreeFinalizedAt?: number;
  worktreeCleanupError?: string;
}

export interface Launch {
  name: string;
  sessionId: string;
  loadout: Loadout;
  parentPane?: string;
  mailbox: string;
  inspection: boolean;
  inspectionStatus?: Status;
}

export interface Activity {
  status: "starting" | "active" | "waiting";
  detail: string;
  since?: number;
  waitingFor?: WaitingFor;
  pid: number;
  sessionFile?: string;
  updatedAt: number;
  keepOpen: boolean;
}

export interface Completion {
  id: string;
  status: "done" | "error" | "cancelled" | "needs-input";
  text: string;
  question?: string;
  sessionFile?: string;
  completedAt: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

export interface Control { keepOpen: boolean; cancel?: boolean }
export interface Mail { message: string }

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

export function runFile(job: Job, file: string): string { return join(job.run, file); }

export function uniqueName(requested: string, existing: Iterable<string>): string {
  const base = requested.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(base)) {
    throw new Error("Agent names must be 1–64 letters, digits, dots, underscores, or hyphens, starting with a letter or digit.");
  }
  const used = new Set(existing);
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
  return name;
}

export function capOutput(text: string, artifact: string, maxBytes = 24 * 1024): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  // Avoid splitting a UTF-8 code point.
  let end = maxBytes;
  while ((buffer[end] & 0xc0) === 0x80) end--;
  return `${buffer.subarray(0, end).toString("utf8")}\n\n[Truncated. Full result: ${artifact}]`;
}
