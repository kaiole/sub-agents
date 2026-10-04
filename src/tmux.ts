import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

export interface Surface { windowId: string; paneId: string }
export interface Pane extends Surface { dead: boolean; run: string }

export function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

/** Reuse the running Pi executable, including npm and standalone/bundled installations. */
export function piInvocation(args: string[]): string[] {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script) && /(?:^|\/)cli\.(?:js|ts)$/.test(script)) {
    return [process.execPath, script, ...args];
  }
  if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) return [process.execPath, ...args];
  return ["pi", ...args];
}

export class Tmux {
  constructor(private socketName?: string) {}

  command(args: string[]): string {
    return execFileSync("tmux", [...(this.socketName ? ["-L", this.socketName] : []), ...args], {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  session(parentPane: string): string {
    const id = this.command(["display-message", "-p", "-t", parentPane, "#{session_id}"]);
    if (!/^\$\d+$/.test(id)) throw new Error("Start the parent Pi inside tmux before spawning subagents.");
    return id;
  }

  create(parentPane: string, name: string, cwd: string, script: string, run: string): Surface {
    const session = this.session(parentPane);
    // tmux otherwise uses its server/session environment, which may lack credentials or PATH changes.
    // Pass values in argv, never write credentials into launch artifacts.
    const environment = Object.entries(process.env).flatMap(([key, value]) =>
      value !== undefined && !["TMUX", "TMUX_PANE", "TERM", "COLUMNS", "LINES", "SHLVL", "_", "PI_TUI_WRITE_LOG"].includes(key)
        ? ["-e", `${key}=${value}`] : []);
    const output = this.command([
      "new-window", "-d", "-P", "-F", "#{window_id}\t#{pane_id}",
      "-t", `${session}:`, "-n", `agent:${name}`, "-c", cwd, ...environment,
      `${quote("/bin/bash")} ${quote(script)}`,
    ]);
    const [windowId, paneId] = output.split("\t");
    if (!/^@\d+$/.test(windowId) || !/^%\d+$/.test(paneId)) throw new Error(`Unexpected tmux response: ${output}`);
    try {
      this.command(["set-option", "-w", "-t", windowId, "@pi_subagent_run", run]);
      // Override user defaults so completed workers do not leave dead panes behind.
      this.command(["set-option", "-w", "-t", windowId, "remain-on-exit", "off"]);
      this.command(["set-option", "-w", "-t", windowId, "automatic-rename", "off"]);
    } catch (error) {
      // A startup failure may already have exited, with its exit status captured by the script.
      if (!existsSync(`${run}/exit.json`)) {
        try { this.command(["kill-window", "-t", windowId]); } catch { /* already gone */ }
        throw error;
      }
    }
    return { windowId, paneId };
  }

  panes(): Pane[] {
    return this.command(["list-panes", "-a", "-F", "#{window_id}\t#{pane_id}\t#{pane_dead}\t#{@pi_subagent_run}"])
      .split("\n").filter(Boolean).map((line) => {
        const [windowId, paneId, dead, run] = line.split("\t");
        return { windowId, paneId, dead: dead === "1", run: run ?? "" };
      });
  }

  open(paneId: string): void {
    this.command(["select-window", "-t", paneId]);
    this.command(["select-pane", "-t", paneId]);
  }

  kill(paneId: string): void { this.command(["kill-pane", "-t", paneId]); }
}
