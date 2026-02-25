import * as os from "node:os";
import * as path from "node:path";
import { execSync, type ExecSyncOptions } from "node:child_process";
import { type RepoId, logFile, ensureDir, logDir, ensureBuffaloTmuxConf } from "./config.js";

const EXEC_OPTS: ExecSyncOptions = { stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" };

// All buffalo tmux operations use a dedicated socket so they are isolated from
// the user's personal tmux server and work regardless of socket configuration.
// -f points tmux at our own minimal config instead of the user's ~/.tmux.conf.
const BUFFALO_SOCKET = ["-L", "buffalo", "-f", path.join(os.homedir(), ".buffalo", "tmux.conf")] as const;

function sessionName(id: RepoId): string {
  return `buffalo-${id.owner}-${id.repo}`;
}

function run(cmd: string): string {
  // Inject -L buffalo after "tmux" to use the dedicated socket
  const final = cmd.replace(/^tmux /, `tmux ${BUFFALO_SOCKET.join(" ")} `);
  try {
    return (execSync(final, EXEC_OPTS) as string).trim();
  } catch {
    return "";
  }
}

function sessionExists(id: RepoId): boolean {
  return run(`tmux has-session -t ${sessionName(id)} 2>/dev/null && echo yes`) === "yes";
}

export function ensureSession(id: RepoId): void {
  if (!sessionExists(id)) {
    ensureBuffaloTmuxConf(); // writes ~/.buffalo/tmux.conf if missing before server starts
    run(`tmux new-session -d -s ${sessionName(id)} -x 200 -y 50`);
  }
}

export function windowExists(id: RepoId, branch: string): boolean {
  const result = run(`tmux list-windows -t ${sessionName(id)} -F "#{window_name}" 2>/dev/null`);
  return result.split("\n").includes(branch);
}

export function createWindow(id: RepoId, branch: string, cwd: string): void {
  ensureSession(id);
  if (windowExists(id, branch)) return;
  run(`tmux new-window -t ${sessionName(id)} -n ${branch} -c ${cwd}`);
}

export function runInWindow(id: RepoId, branch: string, command: string): void {
  const escaped = command.replace(/'/g, "'\\''");
  run(`tmux send-keys -t ${sessionName(id)}:${branch} '${escaped}' Enter`);
}

export function sendKeys(id: RepoId, branch: string, keys: string): void {
  const escaped = keys.replace(/'/g, "'\\''");
  run(`tmux send-keys -t ${sessionName(id)}:${branch} '${escaped}' Enter`);
}

export function pipeOutput(id: RepoId, branch: string): void {
  ensureDir(logDir(id));
  const log = logFile(id, branch);
  run(`tmux pipe-pane -t ${sessionName(id)}:${branch} -o 'cat >> ${log}'`);
}

export function destroyWindow(id: RepoId, branch: string): void {
  run(`tmux kill-window -t ${sessionName(id)}:${branch} 2>/dev/null`);
}

export async function attachToTarget(target: string): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  // Unset TMUX so tmux doesn't refuse to nest. Using a dedicated socket
  // (-L buffalo) means we're always talking to buffalo's own tmux server,
  // not the user's personal one — no socket confusion across environments.
  const { TMUX: _, ...env } = process.env;
  console.log(`[buffalo] Attaching to tmux target: ${target}`);
  try {
    execFileSync("tmux", [...BUFFALO_SOCKET, "attach-session", "-t", target], { stdio: "inherit", env });
  } catch (err: any) {
    console.error(`[buffalo] Failed to attach: ${err.message}`);
  }
}

export async function attachToWindow(id: RepoId, branch?: string): Promise<void> {
  const target = branch ? `${sessionName(id)}:${branch}` : sessionName(id);
  await attachToTarget(target);
}

export interface WindowInfo {
  session: string;
  window: string;
  active: boolean;
}

export function listWindows(): WindowInfo[] {
  const result = run(
    `tmux list-windows -a -F "#{session_name}|#{window_name}|#{window_active}" 2>/dev/null`
  );
  if (!result) return [];
  return result.split("\n").filter(Boolean).map((line) => {
    const [session, window, active] = line.split("|");
    return { session, window, active: active === "1" };
  }).filter((w) => w.session.startsWith("buffalo-"));
}

export function destroySession(id: RepoId): void {
  run(`tmux kill-session -t ${sessionName(id)} 2>/dev/null`);
}
