import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Launch } from "./shared.ts";

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

// Render identifiers as text, never terminal control sequences.
function singleLine(text: string): string { return text.replace(/[\x00-\x1f\x7f-\x9f]/g, ""); }

/** Preserve worker-management details before sacrificing left-side detail. */
function layout(isolation: string, left: string, right: string, width: number): string {
  const available = Math.max(0, width - 1);
  const isolationWidth = visibleWidth(isolation);
  const rightWidth = visibleWidth(right);
  if (available <= isolationWidth + rightWidth + 1) return truncateToWidth(` ${isolation} ${right}`, width, "");
  const fittedLeft = truncateToWidth(left, Math.max(0, available - isolationWidth - rightWidth - 2));
  const prefix = fittedLeft ? `${isolation} ${fittedLeft}` : isolation;
  const gap = " ".repeat(Math.max(1, available - visibleWidth(prefix) - rightWidth));
  return truncateToWidth(` ${prefix}${gap}${right}`, width, "");
}

/** Installed only by the worker controller. State changes use its existing control poll. */
export function installWorkerFooter(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  launch: Pick<Launch, "name" | "loadout" | "isolation">,
  keepOpen: () => boolean,
): () => void {
  if (ctx.mode !== "tui") return () => {};
  let requestRender: (() => void) | undefined;
  ctx.ui.setFooter((tui, theme) => {
    const render = () => tui.requestRender();
    requestRender = render;
    return {
      dispose() {
        if (requestRender === render) requestRender = undefined;
      },
      invalidate() {},
      render(width: number): string[] {
        const usage = ctx.getContextUsage();
        const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const percent = usage?.percent == null ? "?" : usage.percent.toFixed(0);
        const tokens = usage?.tokens == null ? "?" : formatTokens(usage.tokens);
        const context = theme.fg("thinkingLow", `${percent}%`) + theme.fg("muted", ` [${tokens}/${formatTokens(window)}]`);
        const thinking = ctx.model?.reasoning ? ` • ${pi.getThinkingLevel()}` : "";
        const left = theme.fg("thinkingLow", "| ") + [
          theme.fg("muted", `${singleLine(ctx.model?.id ?? "no-model")}${thinking}`),
          context,
        ].join(theme.fg("thinkingLow", " | "));
        // Old launch snapshots lack isolation metadata; do not guess from a path.
        const isolation = launch.isolation ?? "unknown";
        const badge = theme.fg("muted", `[${singleLine(`${launch.name}:${launch.loadout.agent}`)}]`)
          + theme.fg("thinkingLow", ` ${isolation}`);
        const pinned = keepOpen();
        const behavior = theme.fg("muted", pinned ? "pinned" : "auto-exit");
        return [layout(badge, left, behavior, width), ""];
      },
    };
  });
  return () => requestRender?.();
}
