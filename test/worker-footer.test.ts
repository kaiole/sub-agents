import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { installWorkerFooter } from "../src/worker-footer.ts";
import type { Launch } from "../src/shared.ts";

type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;

function setup(isolation: Launch["isolation"] | "legacy" = "worktree", mode = "tui", name = "fix-auth") {
  let footer: ReturnType<FooterFactory> | undefined;
  let renders = 0;
  let pinned = false;
  let usage: ReturnType<ExtensionContext["getContextUsage"]> = { percent: 3.2, tokens: 8700, contextWindow: 272000 };
  const theme = { fg: (color: string, text: string) => `\x1b[${({ warning: 33, accent: 36, error: 31, thinkingLow: 32, muted: 90, dim: 2 } as Record<string, number>)[color]}m${text}\x1b[0m` };
  const ctx = {
    mode,
    model: { id: "gpt-6.1-sol", reasoning: true, contextWindow: 272000 },
    getContextUsage: () => usage,
    sessionManager: { getCwd: () => { throw new Error("Footer must not read the path"); } },
    ui: { setFooter(factory: FooterFactory) {
      footer = factory(
        { requestRender: () => { renders++; } } as Parameters<FooterFactory>[0],
        theme as Parameters<FooterFactory>[1],
        {
          getGitBranch: () => { throw new Error("Footer must not read the branch"); },
          onBranchChange: () => { throw new Error("Footer must not watch the branch"); },
          getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1,
        } as Parameters<FooterFactory>[2],
      );
    } },
  } as unknown as ExtensionContext;
  const pi = { getThinkingLevel: () => "high" } as unknown as ExtensionAPI;
  const refresh = installWorkerFooter(pi, ctx, {
    name, isolation: isolation === "legacy" ? undefined : isolation,
    loadout: { agent: "worker" } as Launch["loadout"],
  }, () => pinned);
  return {
    ctx, refresh,
    render: (width = 180) => footer!.render(width),
    dispose: () => footer!.dispose?.(),
    pin: (value: boolean) => { pinned = value; refresh(); },
    usage: (value: typeof usage) => { usage = value; },
    get renders() { return renders; }, get installed() { return !!footer; },
  };
}

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

test("worker footer groups isolation/task/model/context left and lifecycle right", () => {
  const h = setup();
  const lines = h.render();
  assert.equal(lines.length, 2);
  assert.equal(lines[1], "");
  const line = plain(lines[0]);
  assert.match(line, /^ \[fix-auth:worker\] worktree \| gpt-6.1-sol • high \| 3% \[8.7k\/272k\] +auto-exit$/);
  assert.ok(lines[0].includes("\x1b[90m[fix-auth:worker]"));
  assert.ok(lines[0].includes("\x1b[32m worktree"));
  assert.ok(lines[0].includes("\x1b[32m3%"));
  assert.equal(visibleWidth(lines[0]), 180);
  h.pin(true);
  assert.ok(plain(h.render()[0]).endsWith(" pinned"));
  assert.ok(h.render()[0].includes("\x1b[90mpinned"));
  assert.equal(h.renders, 1);
});

test("isolation uses thinkingLow; legacy snapshots show unknown rather than guessing", () => {
  const h = setup("shared");
  assert.ok(h.render()[0].includes("\x1b[32m shared"));
  assert.ok(setup("legacy").render()[0].includes("\x1b[32m unknown"));
});

test("unknown context/model and non-reasoning models are rendered honestly", () => {
  const h = setup();
  h.usage(undefined);
  assert.ok(plain(h.render()[0]).includes("?% [?/272k]"));
  h.ctx.model = undefined;
  assert.ok(plain(h.render()[0]).includes(" | no-model | ?% [?/0]"));
  h.ctx.model = { id: "plain-model", reasoning: false, contextWindow: 64000 } as ExtensionContext["model"];
  assert.ok(plain(h.render()[0]).includes(" | plain-model | ?% [?/64k]"));
  h.usage({ percent: 0, tokens: 0, contextWindow: 64000 });
  assert.ok(plain(h.render()[0]).includes("0% [0/64k]"));
});

test("worker-management details survive narrow widths, ANSI and wide identifiers", () => {
  const h = setup("shared", "tui", "你好");
  h.ctx.model!.id = "你好🙂".repeat(60);
  for (let width = 0; width <= 220; width++) {
    const line = h.render(width)[0];
    assert.ok(visibleWidth(line) <= width, `overflow at ${width}`);
    if (width >= 33) assert.ok(plain(line).startsWith(" [你好:worker] shared") && plain(line).endsWith("auto-exit"), `lost worker controls at ${width}`);
  }
  h.pin(true);
  assert.ok(plain(h.render(40)[0]).endsWith(" pinned"));
});

test("context percentages always use thinkingLow, including high and unknown usage", () => {
  const h = setup();
  for (const percent of [0, 70, 90, 100]) {
    h.usage({ percent, tokens: 272000 * percent / 100, contextWindow: 272000 });
    assert.ok(h.render()[0].includes(`\x1b[32m${percent}%`));
  }
  h.usage(undefined);
  assert.ok(h.render()[0].includes("\x1b[32m?%"));
});

test("terminal controls in identifiers cannot add lines or escape sequences", () => {
  const h = setup("shared", "tui", "task\n\t\x1b[2J");
  assert.ok(!/[\n\r\t\x1b]/.test(plain(h.render()[0])));
});

test("disposed footer refresh callbacks are inert", () => {
  const h = setup();
  h.refresh();
  assert.equal(h.renders, 1);
  h.dispose();
  h.refresh();
  assert.equal(h.renders, 1);
});

test("non-TUI modes never install terminal components", () => {
  for (const mode of ["rpc", "json", "print"]) {
    const h = setup("shared", mode);
    assert.equal(h.installed, false);
    h.refresh();
    assert.equal(h.renders, 0);
  }
});
