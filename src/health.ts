import { readJson, type Activity, type Health } from "./shared.ts";

export const STALE_HEARTBEAT_MS = 60_000;

/** A corrupt/missing snapshot is a monitoring problem, not proof the worker exited. */
export function readActivity(path: string): Activity | undefined {
  try {
    const value = readJson<Activity>(path);
    if (!value || !["starting", "active", "waiting"].includes(value.status) ||
      typeof value.detail !== "string" || !Number.isFinite(value.updatedAt) || value.updatedAt < 0 ||
      !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      (value.since !== undefined && (!Number.isFinite(value.since) || value.since < 0)) ||
      (value.waitingFor !== undefined && !["human-input", "clarification", "inspection", "release"].includes(value.waitingFor)) ||
      (value.keepOpen !== undefined && typeof value.keepOpen !== "boolean") ||
      (value.sessionFile !== undefined && typeof value.sessionFile !== "string")) return undefined;
    return value;
  } catch { return undefined; }
}

export function heartbeatHealth(lastHeartbeatAt: number, now: number, staleAfterMs = STALE_HEARTBEAT_MS): Health {
  return now - lastHeartbeatAt > staleAfterMs ? "stalled" : "healthy";
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
