import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { parseAgent, resolveLoadout } from "../src/agents.ts";
import { renderPreloadedSkills } from "../src/skills.ts";

function profile(fields = "") {
  return parseAgent(`---\nname: worker\ndescription: Test\ntools: read\n${fields}\n---\nWorker instructions`, "/agents/worker.md");
}

function setup(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-skills-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { cwd: dir, isProjectTrusted: () => true } as unknown as ExtensionContext;
  function skill(name: string, body = `Instructions for ${name}.`, frontmatter = "") {
    const path = join(dir, "enabled-custom-resources", name, "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nname: ${name}\ndescription: Test\n${frontmatter}\n---\n${body}`);
    return path;
  }
  return { dir, ctx, skill };
}

function command(name: string, path: string, scope: "user" | "project" | "temporary" = "user"): SlashCommandInfo {
  return {
    name: `skill:${name}`,
    source: "skill",
    sourceInfo: { path, scope, source: "settings", origin: "top-level" },
  };
}

function parent(commands: SlashCommandInfo[] = []) {
  return {
    getCommands: () => commands,
    getAllTools: () => [],
    getThinkingLevel: () => "low",
  } as unknown as ExtensionAPI;
}

test("profile skills accept YAML arrays and comma lists, trimming and deduplicating names", () => {
  assert.deepEqual(profile('skills: [pdf-reading, " brainstorm ", pdf-reading]').skills, ["pdf-reading", "brainstorm"]);
  assert.deepEqual(profile("skills: pdf-reading, brainstorm, pdf-reading").skills, ["pdf-reading", "brainstorm"]);
  assert.deepEqual(profile("skills:\n  - pdf-reading\n  - brainstorm\n  - pdf-reading").skills, ["pdf-reading", "brainstorm"]);
  assert.deepEqual(profile().skills, []);
  assert.deepEqual(profile("skills: []").skills, []);
});

test("profile skills reject empty names and non-string entries", () => {
  for (const field of [
    'skills: ""', 'skills: "   "', "skills: read,", 'skills: ",read"', "skills: [read, 7]",
    'skills: [read, ""]', 'skills: ["  "]', "skills: [null]", "skills: null", "skills: true", "skills: {name: read}",
  ]) {
    assert.throws(() => profile(field), /skills must be a comma-separated string or an array of nonempty strings/, field);
  }
});

test("profiles without skills do not query commands and omit skills from the loadout", (t) => {
  const { ctx } = setup(t);
  const pi = parent();
  pi.getCommands = () => { throw new Error("getCommands must not be called"); };
  for (const agent of [profile(), profile("skills: []")]) {
    const loadout = resolveLoadout(agent, pi, ctx);
    assert.equal(Object.hasOwn(loadout, "skills"), false);
  }
  assert.equal(renderPreloadedSkills(undefined), "");
  assert.equal(renderPreloadedSkills([]), "");
});

test("loadouts use exact parent skill commands, including enabled package/custom and explicit-only skills", (t) => {
  const { ctx, skill } = setup(t);
  const pdf = skill("pdf-reading", "Read references/format.md.");
  const manual = skill("manual-only", "Explicit instructions.", "disable-model-invocation: true");
  const packaged = command("pdf-reading", pdf);
  packaged.sourceInfo.source = "npm:@example/skills";
  packaged.sourceInfo.origin = "package";
  const commands = [
    { ...command("pdf-reading", "/not-the-skill.md"), source: "extension" as const },
    packaged,
    command("manual-only", manual, "temporary"),
  ];
  const pi = parent(commands);
  let queries = 0;
  pi.getCommands = () => { queries++; return commands; };
  const loadout = resolveLoadout(profile("skills: manual-only, pdf-reading, manual-only"), pi, ctx);
  assert.equal(queries, 1);
  assert.deepEqual(loadout.skills, [
    { name: "manual-only", path: manual, content: "Explicit instructions." },
    { name: "pdf-reading", path: pdf, content: "Read references/format.md." },
  ]);
  assert.equal(loadout.systemPrompt, "Worker instructions");
});

test("unavailable skills fail clearly instead of discovering files or accepting other command sources", (t) => {
  const { ctx, skill } = setup(t);
  const path = skill("local-only");
  const agent = profile("skills: local-only");
  for (const commands of [
    [],
    [{ ...command("local-only", path), source: "prompt" as const }],
    [{ ...command("local-only", path), source: "extension" as const }],
    [{ ...command("local-only", path), name: "local-only" }],
  ]) {
    assert.throws(() => resolveLoadout(agent, parent(commands), ctx), /Skill 'local-only' is unavailable in the parent/);
  }
});

test("skill sources must be absolute and readable; missing files and malformed frontmatter identify the skill and path", (t) => {
  const { ctx, dir, skill } = setup(t);
  const agent = profile("skills: broken");
  for (const path of ["relative/SKILL.md", ""]) {
    assert.throws(() => resolveLoadout(agent, parent([command("broken", path)]), ctx), /skill 'broken'.*absolute skill file path/);
  }
  const missing = join(dir, "missing", "SKILL.md");
  assert.throws(() => resolveLoadout(agent, parent([command("broken", missing)]), ctx), (error: Error) => {
    assert.match(error.message, /Cannot preload skill 'broken'/);
    assert.ok(error.message.includes(missing));
    assert.match(error.message, /ENOENT/);
    return true;
  });
  const malformed = skill("broken");
  writeFileSync(malformed, "---\nname: [broken\n---\nInstructions");
  assert.throws(() => resolveLoadout(agent, parent([command("broken", malformed)]), ctx), /Cannot preload skill 'broken'/);
  assert.throws(() => resolveLoadout(agent, parent([command("broken", dir)]), ctx), /Cannot preload skill 'broken'/);
});

test("project skills require parent project trust even if present in command metadata", (t) => {
  const { ctx, skill } = setup(t);
  const path = skill("project-workflow");
  const pi = parent([command("project-workflow", path, "project")]);
  const agent = profile("skills: project-workflow");
  const untrusted = { ...ctx, isProjectTrusted: () => false } as ExtensionContext;
  assert.throws(() => resolveLoadout(agent, pi, untrusted), /project skill 'project-workflow'.*parent project is not trusted/);
  assert.equal(resolveLoadout(agent, pi, ctx).skills?.[0].path, path);
  // Trust is checked before reading the source, not inferred from the worker's cwd.
  unlinkSync(path);
  assert.throws(() => resolveLoadout(agent, pi, untrusted), /parent project is not trusted/);
});

test("user and temporary skills do not require project trust", (t) => {
  const { ctx, skill } = setup(t);
  const path = skill("personal-workflow");
  const untrusted = { ...ctx, isProjectTrusted: () => false } as ExtensionContext;
  for (const scope of ["user", "temporary"] as const) {
    const loadout = resolveLoadout(profile("skills: personal-workflow"), parent([command("personal-workflow", path, scope)]), untrusted);
    assert.equal(loadout.skills?.[0].path, path);
    assert.equal(loadout.approveProject, false);
  }
});

test("trusted parent project skills intentionally apply at another cwd without rediscovery or auto-approval", (t) => {
  const { dir, ctx, skill } = setup(t);
  const path = skill("project-workflow", "Original project workflow.");
  const workerDir = join(dir, "other-project");
  mkdirSync(workerDir);
  const loadout = resolveLoadout(profile("skills: project-workflow"), parent([command("project-workflow", path, "project")]), ctx, workerDir);
  assert.equal(loadout.cwd, workerDir);
  assert.equal(loadout.approveProject, false);
  assert.deepEqual(loadout.skills, [{ name: "project-workflow", path, content: "Original project workflow." }]);
  assert.ok(renderPreloadedSkills(loadout.skills).includes(`References are relative to ${dirname(path)}.`));
});

test("skill bodies and paths are saved snapshots; rendering never rereads changed or removed sources", (t) => {
  const { ctx, skill } = setup(t);
  const path = skill("workflow", "Read references/details.md.\nRun scripts/run.sh.");
  const source = command("workflow", path);
  const loadout = resolveLoadout(profile("skills: workflow"), parent([source]), ctx);
  const rendered = renderPreloadedSkills(loadout.skills);
  assert.ok(rendered.includes(`<skill name="workflow" location="${path}">`));
  assert.ok(rendered.includes(`References are relative to ${dirname(path)}.`));
  assert.match(rendered, /Resolve relative paths against that directory, not the working directory/);
  assert.match(rendered, /Follow their instructions/);
  assert.match(rendered, /Read references\/details.md/);
  assert.ok(!rendered.includes("description: Test"));
  assert.ok(!rendered.includes("name: workflow"));
  writeFileSync(path, "New instructions.");
  source.sourceInfo.path = "/different/SKILL.md";
  assert.equal(renderPreloadedSkills(loadout.skills), rendered);
  unlinkSync(path);
  assert.equal(renderPreloadedSkills(loadout.skills), rendered);
});

test("rendering keeps multiple instructional blocks and escapes attribute metadata", () => {
  const text = renderPreloadedSkills([
    { name: "one", path: "/skills/one/SKILL.md", content: "First instructions." },
    { name: 'two"&', path: '/skills/two"&/SKILL.md', content: "Second instructions." },
  ]);
  assert.equal((text.match(/<skill /g) ?? []).length, 2);
  assert.match(text, /First instructions\./);
  assert.match(text, /Second instructions\./);
  assert.ok(text.includes('name="two&quot;&amp;"'));
  assert.ok(text.includes('location="/skills/two&quot;&amp;/SKILL.md"'));
});

test("ask_question is a worker controller tool, while nested subagent tools remain forbidden", (t) => {
  const { ctx } = setup(t);
  const pi = parent();
  pi.getAllTools = () => [{ name: "ask_question", sourceInfo: { path: "/parent-question-extension.ts" } }] as ReturnType<ExtensionAPI["getAllTools"]>;
  const agent = { ...profile(), tools: ["read", "ask_question"] };
  const loadout = resolveLoadout(agent, pi, ctx);
  assert.deepEqual(loadout.tools, ["read", "ask_question"]);
  assert.deepEqual(loadout.extensions, []);
  for (const name of ["subagent", "subagent_spawn", "subagent_message", "subagents"]) {
    assert.throws(() => resolveLoadout({ ...agent, tools: [name], extensions: ["/explicit-extension.ts"] }, pi, ctx), /Nested subagents are not supported/);
  }
});
