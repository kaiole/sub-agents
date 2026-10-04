import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { BUILTIN_TOOLS, type Loadout } from "./shared.ts";

export interface Agent {
  name: string;
  description: string;
  tools: string[];
  extensions: string[];
  model?: string;
  thinking?: ThinkingLevel;
  cwd?: string;
  keepOpen: boolean;
  systemPrompt: string;
  source: string;
}

const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const bundledDir = fileURLToPath(new URL("../agents/", import.meta.url));

function list(value: unknown, field: string): string[] {
  const raw = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be a comma-separated string or an array of nonempty strings`);
  }
  return [...new Set(raw.map((item: string) => item.trim()))];
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value.trim();
}

export function parseAgent(content: string, file: string): Agent {
  const { frontmatter: f, body } = parseFrontmatter<Record<string, unknown>>(content);
  const name = optionalString(f.name, "name");
  const description = optionalString(f.description, "description");
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name) || !description) {
    throw new Error("A valid name and description are required");
  }
  const tools = list(f.tools, "tools");
  if (!tools.length) throw new Error("tools must not be empty");
  const thinking = optionalString(f.thinking, "thinking");
  if (thinking && !LEVELS.has(thinking)) throw new Error(`Invalid thinking level: ${thinking}`);
  for (const key of ["keep-open", "auto-exit"]) {
    if (f[key] !== undefined && typeof f[key] !== "boolean") throw new Error(`${key} must be boolean`);
  }
  // Do not silently accept upstream settings that would grant recursion or imply copied context.
  if (f.subagent_agents !== undefined || (f["session-mode"] !== undefined && f["session-mode"] !== "standalone") || f.cli !== undefined) {
    throw new Error("Nested agents, non-standalone session modes, and other CLIs are not supported");
  }
  if (f["system-prompt"] !== undefined && f["system-prompt"] !== "append") {
    throw new Error("Only system-prompt: append is supported");
  }
  return {
    name, description, tools,
    extensions: f.extensions === undefined ? [] : list(f.extensions, "extensions").map((p) =>
      p.startsWith("builtin:") ? p : resolve(dirname(file), p.startsWith("~/") ? join(homedir(), p.slice(2)) : p)),
    model: optionalString(f.model, "model"),
    thinking: thinking as ThinkingLevel | undefined,
    cwd: optionalString(f.cwd, "cwd"),
    keepOpen: (f["keep-open"] ?? (f["auto-exit"] === false)) as boolean,
    systemPrompt: body.trim(),
    source: file,
  };
}

function nearestProjectDir(cwd: string): string | undefined {
  let current = resolve(cwd);
  for (;;) {
    const dir = join(current, ".pi", "agents");
    if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function discoverAgents(cwd: string, trusted: boolean): { agents: Agent[]; warnings: string[] } {
  const agents = new Map<string, Agent>();
  const warnings: string[] = [];
  const dirs = [bundledDir, join(getAgentDir(), "agents")];
  const project = trusted ? nearestProjectDir(cwd) : undefined;
  if (project) dirs.push(project);
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
      const file = join(dir, name);
      try {
        const agent = parseAgent(readFileSync(file, "utf8"), file);
        agents.set(agent.name, agent);
      } catch (error) {
        // A broken override must not silently fall back to a less restricted bundled profile.
        agents.delete(name.slice(0, -3));
        warnings.push(`${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
  return { agents: [...agents.values()], warnings };
}

export function resolveLoadout(agent: Agent, pi: ExtensionAPI, ctx: ExtensionContext, cwdOverride?: string, modelOverride?: string): Loadout {
  const extensions = new Set(agent.extensions);
  const known = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  for (const name of agent.tools) {
    if (name.startsWith("subagent") || name === "ask_question") throw new Error("Nested subagents are not supported");
    if (BUILTIN_TOOLS.has(name)) continue;
    const source = known.get(name)?.sourceInfo.path;
    if (!source) {
      if (agent.extensions.length) continue; // Explicit extensions are validated by the child after loading.
      throw new Error(`Tool '${name}' is unavailable. Load its extension in the parent or list extensions in ${agent.source}.`);
    }
    if (source.startsWith("builtin:") || isAbsolute(source)) extensions.add(source);
    else throw new Error(`Cannot load '${name}' from ${source} in a child process. Specify an extension file explicitly.`);
  }
  const rawCwd = cwdOverride ?? agent.cwd ?? ctx.cwd;
  const cwd = resolve(ctx.cwd, rawCwd.startsWith("~/") ? join(homedir(), rawCwd.slice(2)) : rawCwd);
  if (!statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  return {
    agent: agent.name,
    tools: [...agent.tools],
    extensions: [...extensions],
    systemPrompt: agent.systemPrompt,
    model: modelOverride ?? agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
    thinking: agent.thinking ?? ctx.thinkingLevel ?? pi.getThinkingLevel(),
    cwd,
    // Never auto-approve a different working directory just because the parent's is trusted.
    approveProject: cwd === resolve(ctx.cwd) && ctx.isProjectTrusted(),
  };
}
