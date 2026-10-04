import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Manager } from "../src/manager.ts";
import { writeJson, type Completion } from "../src/shared.ts";
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
