import { readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { parseFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PreloadedSkill } from "./shared.ts";

/** Resolve the parent's enabled resources, never rediscover skills at the worker cwd. */
export function resolvePreloadedSkills(names: string[], pi: ExtensionAPI, ctx: ExtensionContext): PreloadedSkill[] {
  if (!names.length) return [];
  const commands = new Map(pi.getCommands().filter((command) => command.source === "skill").map((command) => [command.name, command]));
  return names.map((name) => {
    const command = commands.get(`skill:${name}`);
    if (!command) throw new Error(`Skill '${name}' is unavailable in the parent. Enable it in Pi before preloading it.`);
    const path = command.sourceInfo.path;
    if (!path || !isAbsolute(path)) {
      throw new Error(`Cannot preload skill '${name}': its source must be an absolute skill file path (got ${JSON.stringify(path)}).`);
    }
    if (command.sourceInfo.scope === "project" && !ctx.isProjectTrusted()) {
      throw new Error(`Cannot preload project skill '${name}' from ${path}: the parent project is not trusted.`);
    }
    try {
      return { name, path, content: parseFrontmatter(readFileSync(path, "utf8")).body };
    } catch (error) {
      throw new Error(`Cannot preload skill '${name}' from ${path}: ${error instanceof Error ? error.message : error}`);
    }
  });
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Render only the saved snapshot: startup/resume must not reread mutable source files. */
export function renderPreloadedSkills(skills: PreloadedSkill[] | undefined): string {
  if (!skills?.length) return "";
  return [
    "The following skills are preloaded for this agent. Follow their instructions; the skill bodies are already included below.",
    ...skills.map((skill) => [
      `<skill name="${escapeAttribute(skill.name)}" location="${escapeAttribute(skill.path)}">`,
      `References are relative to ${dirname(skill.path)}. Resolve relative paths against that directory, not the working directory.`,
      "",
      skill.content,
      "</skill>",
    ].join("\n")),
  ].join("\n\n");
}
