import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type RepoId,
  detectRepoFromCwd,
  detectAllRemotes,
  getAllRepos,
  loadWhitelist,
  saveGlobalWhitelist,
  loadRepoConfig,
  logFile,
  pidFile,
  repoDir,
} from "./config.js";
import { attachToTarget, attachToWindow, listWindows, destroySession } from "./tmux-manager.js";
import { pauseSession, resumeSession, loadSessions, clearBranchResumable, shouldResumeBranch, type SessionInfo } from "./session-store.js";
import { readHistory } from "./history.js";
import { listOpenPRs } from "./github.js";
import { ensureWorkspace, rollbackLastCommit } from "./repo-manager.js";
import { buildPrompt } from "./batch.js";
import { startCliSession } from "./cli-runner.js";
import { setSession } from "./session-store.js";
import {
  startPolling,
  stopPolling,
  getPollerStatus,
  getRecentPollerErrors,
} from "./poller.js";
import { runInit } from "./init.js";

function getCurrentBranch(): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function requireRepo(): RepoId {
  const id = detectRepoFromCwd();
  if (!id) {
    console.error("Not in a git repo or can't detect remote. Specify --repo owner/repo");
    process.exit(1);
  }
  return id;
}

function parseRepoArg(arg: string): RepoId | null {
  const parts = arg.split("/");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { owner: parts[0], repo: parts[1] };
  }
  return null;
}

function hasExistingConfig(id: RepoId): boolean {
  return fs.existsSync(
    path.join(repoDir(id), "config.json")
  );
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
} as const;

type ColorName = keyof typeof ANSI;

interface StatusRepoSnapshot {
  id: RepoId;
  pid: number | null;
  isPolling: boolean;
  pollerState: ReturnType<typeof getPollerStatus>;
  sessions: Record<string, SessionInfo>;
}

interface StatusRenderOptions {
  color?: boolean;
  now?: number;
  detailed?: boolean;
}

function shouldUseColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(process.stdout?.isTTY) && process.env.TERM !== "dumb";
}

function paint(text: string, colors: ColorName[], enabled: boolean): string {
  if (!enabled || colors.length === 0) return text;
  return `${colors.map((c) => ANSI[c]).join("")}${text}${ANSI.reset}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const remSeconds = seconds % 60;
    return remSeconds === 0 ? `${minutes}m` : `${minutes}m ${remSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}

function formatRelativeTime(ts: string | undefined, now: number): string | null {
  if (!ts) return null;
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return null;
  const delta = Math.max(0, now - parsed);
  if (delta < 1000) return "just now";
  return `${formatDuration(delta)} ago`;
}

function singleLine(text: string | undefined): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function truncate(text: string, max = 88): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function padCell(text: string, width: number): string {
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, index) => {
    const cellWidths = rows.map((row) => row[index]?.length ?? 0);
    return Math.max(header.length, ...cellWidths);
  });

  const formatRow = (row: string[]) =>
    `  ${row.map((cell, index) => padCell(cell, widths[index])).join(" | ")}`;

  const divider = `  ${widths.map((width) => "-".repeat(width)).join("-+-")}`;
  return [
    formatRow(headers),
    divider,
    ...rows.map((row) => formatRow(row)),
  ];
}

function humanizeSessionStatus(status: SessionInfo["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "waiting_approval":
      return "Waiting For Approval";
    case "waiting_clarification":
      return "Waiting For Clarification";
    case "completed":
      return "Completed";
    case "paused":
      return "Paused";
  }
}

function humanizeErrorKind(kind: string): string {
  return kind.replace(/_/g, " ");
}

function sessionStatusColor(status: SessionInfo["status"]): ColorName[] {
  switch (status) {
    case "running":
      return ["green", "bold"];
    case "waiting_approval":
      return ["yellow", "bold"];
    case "waiting_clarification":
      return ["magenta", "bold"];
    case "completed":
      return ["cyan", "bold"];
    case "paused":
      return ["blue", "bold"];
  }
}

function summarizeHistoryEvent(event: Record<string, unknown> | undefined): string | null {
  if (!event) return null;
  switch (event.type) {
    case "cli_started":
      return "agent session started";
    case "comment_detected":
      return `new comment from @${event.author ?? "unknown"}`;
    case "clarification_answered":
      return "clarification received";
    case "clarification_requested":
      return "clarification requested from reviewer";
    case "command_requested":
      return event.approved ? "command auto-approved" : `approval requested for ${event.failedPart ?? event.command ?? "command"}`;
    case "command_approved":
      return "command approved";
    case "command_denied":
      return "command denied";
    case "comment_posted":
      return "posted response back to GitHub";
    case "commit_pushed":
      return `pushed commit ${String(event.sha ?? "").slice(0, 7)}`;
    case "retry_started":
      return "retry started";
    case "undo_applied":
      return "rolled back latest commit";
    case "pr_opened":
      return `opened PR #${event.pr ?? "?"}`;
    case "issue_session_started":
      return `started issue session #${event.issue ?? "?"}`;
    default:
      return String(event.type).replace(/_/g, " ");
  }
}

function describeSessionActivity(
  id: RepoId,
  branch: string,
  session: SessionInfo,
  now: number
): { current: string; last: string | null; request: string | null; history: string[] } {
  const history = readHistory(id, branch);
  const lastEvent = history.length > 0 ? history[history.length - 1] : undefined;
  const lastSummary = summarizeHistoryEvent(lastEvent);
  const lastWhen = formatRelativeTime(lastEvent?.ts, now);
  const last = lastSummary ? `${lastSummary}${lastWhen ? ` (${lastWhen})` : ""}` : null;
  const recentHistory = history
    .slice(-3)
    .reverse()
    .map((event) => {
      const summary = summarizeHistoryEvent(event);
      const when = formatRelativeTime(event.ts, now);
      if (!summary) return null;
      return `${summary}${when ? ` (${when})` : ""}`;
    })
    .filter((entry): entry is string => Boolean(entry));

  let current: string;
  if (session.status === "waiting_approval" && session.pendingApproval) {
    current = `awaiting approval for \`${session.pendingApproval.failedPart}\``;
  } else if (session.status === "waiting_clarification" && session.pendingClarification) {
    current = `awaiting clarification: ${truncate(singleLine(session.pendingClarification.question) ?? "reviewer response needed")}`;
  } else if (session.status === "paused") {
    current = "paused by user";
  } else if (lastSummary) {
    current = lastSummary;
  } else if (shouldResumeBranch(id, branch)) {
    current = "ready to resume previous Codex thread on the next comment";
  } else {
    current = "session active";
  }

  const trigger = session.triggerComments?.[session.triggerComments.length - 1];
  const request = trigger
    ? `@${trigger.user}: ${truncate(singleLine(trigger.body) ?? "(empty comment)")}`
    : null;

  return { current, last, request, history: recentHistory };
}

export function renderStatusReport(
  repos: StatusRepoSnapshot[],
  recentErrors: Array<{ ts: string; kind: string; repo?: string; message: string }>,
  options: StatusRenderOptions = {}
): string {
  const color = options.color ?? shouldUseColor();
  const now = options.now ?? Date.now();
  const detailed = options.detailed ?? false;

  if (repos.length === 0) {
    return "No repos configured. Run `buffalo init`.";
  }

  const lines: string[] = [];
  lines.push(paint("Buffalo Status", ["bold", "cyan"], color));

  for (const repo of repos) {
    if (lines.length > 1) lines.push("");
    lines.push(paint(`${repo.id.owner}/${repo.id.repo}`, ["bold"], color));

    const pollerLabel = repo.isPolling
      ? paint(`RUNNING (pid ${repo.pid})`, ["green", "bold"], color)
      : paint("STOPPED", ["red", "bold"], color);
    lines.push(`  Poller: ${pollerLabel}`);

    if (repo.pollerState) {
      if (repo.pollerState.failureCount > 0) {
        const retryIn = Math.max(0, repo.pollerState.nextPollAt - now);
        lines.push(
          `  Health: ${paint("degraded", ["yellow", "bold"], color)}; retry in ${formatDuration(retryIn)} after ${repo.pollerState.failureCount} failure(s)`
        );
        if (repo.pollerState.lastError) {
          lines.push(`  Error: ${truncate(singleLine(repo.pollerState.lastError) ?? repo.pollerState.lastError, 120)}`);
        }
        if (repo.pollerState.lastErrorAt) {
          lines.push(`  Error Time: ${new Date(repo.pollerState.lastErrorAt).toLocaleString()}`);
        }
      } else {
        const nextPollIn = Math.max(0, repo.pollerState.nextPollAt - now);
        lines.push(`  Health: ${paint("healthy", ["green"], color)}; next poll in ${formatDuration(nextPollIn)}`);
      }
      if (detailed) {
        lines.push(`  Next Poll At: ${new Date(repo.pollerState.nextPollAt).toLocaleString()}`);
      }
    } else if (detailed) {
      lines.push(`  Health: ${paint("unknown", ["gray"], color)}; poller has not reported state yet`);
    }

    const entries = Object.entries(repo.sessions).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) {
      lines.push(`  Sessions: ${paint("none", ["gray"], color)}`);
      if (detailed) {
        try {
          const cfg = loadRepoConfig(repo.id);
          lines.push(`  Backend: ${cfg.backend}`);
          lines.push(`  Poll Interval: ${formatDuration(cfg.pollIntervalMs)}`);
        } catch {
          // Ignore missing config here; dispatch validates targeted repos.
        }
      }
      continue;
    }

    if (detailed) {
      try {
        const cfg = loadRepoConfig(repo.id);
        lines.push(`  Backend: ${cfg.backend}`);
        lines.push(`  Poll Interval: ${formatDuration(cfg.pollIntervalMs)}`);
      } catch {
        // Ignore missing config here; dispatch validates targeted repos.
      }
    }

    lines.push(`  Sessions: ${entries.length} active`);
    for (const [branch, session] of entries) {
      const label = paint(humanizeSessionStatus(session.status), sessionStatusColor(session.status), color);
      const activity = describeSessionActivity(repo.id, branch, session, now);
      lines.push(`    - ${branch}  PR #${session.prNumber}  ${label}`);
      lines.push(`      Current: ${activity.current}`);
      if (activity.request) lines.push(`      Request: ${activity.request}`);
      if (activity.last && activity.last !== activity.current) {
        lines.push(`      Last: ${activity.last}`);
      }
      if (detailed) {
        if (shouldResumeBranch(repo.id, branch)) {
          lines.push(`      Resume: yes`);
        }
        if (session.pendingApproval) {
          lines.push(`      Approval Command: ${session.pendingApproval.command}`);
        }
        if (session.pendingClarification) {
          lines.push(`      Clarification: ${truncate(singleLine(session.pendingClarification.question) ?? session.pendingClarification.question, 120)}`);
        }
        if (activity.history.length > 0) {
          lines.push(`      Recent Activity:`);
          for (const entry of activity.history) {
            lines.push(`        ${entry}`);
          }
        }
      }
    }
  }

  if (recentErrors.length > 0) {
    lines.push("");
    lines.push(paint("Recent Poller Errors", ["bold", "red"], color));
    lines.push(
      ...renderTable(
        ["remote", "time", "error", "message"],
        recentErrors.map((event) => [
          event.repo ?? "-",
          formatRelativeTime(event.ts, now) ?? event.ts,
          humanizeErrorKind(event.kind),
          truncate(singleLine(event.message) ?? event.message, 80),
        ])
      )
    );
  }

  return lines.join("\n");
}

/**
 * Resolve which repos to target for start/stop.
 * - Explicit arg: use that repo (must be initialized)
 * - In a git repo: use all initialized remotes (error if none)
 * - Not in a repo and no arg: error
 */
function resolveTargetRepos(rest: string[]): RepoId[] {
  const explicit = rest[0] ? parseRepoArg(rest[0]) : null;

  if (explicit) {
    if (!hasExistingConfig(explicit)) {
      console.error(
        `${explicit.owner}/${explicit.repo} is not an initialized Buffalo repo.\n` +
        `Run \`buffalo init\` in the repo directory first.`
      );
      process.exit(1);
    }
    return [explicit];
  }

  // Try detecting from cwd
  const remotes = detectAllRemotes();
  if (remotes.length === 0) {
    console.error(
      "Not in a git repository and no repo specified.\n" +
      "Usage: buffalo start <owner>/<repo>\n" +
      "   or: run from inside a git repo that has been initialized with `buffalo init`."
    );
    process.exit(1);
  }

  const initialized = remotes.filter((r) =>
    hasExistingConfig({ owner: r.owner, repo: r.repo })
  );

  if (initialized.length === 0) {
    console.error(
      "This repository has not been initialized with Buffalo.\n" +
      "Run `buffalo init` first to set up this repo."
    );
    process.exit(1);
  }

  return initialized.map((r) => ({ owner: r.owner, repo: r.repo }));
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writePidFile(id: RepoId, pid: number): void {
  fs.writeFileSync(pidFile(id), String(pid));
}

function readPidFile(id: RepoId): number | null {
  try {
    const pid = parseInt(fs.readFileSync(pidFile(id), "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function removePidFile(id: RepoId): void {
  try { fs.unlinkSync(pidFile(id)); } catch {}
}

function isControlComment(body: string, botUsername: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("allow once") ||
    lower.includes("allow always") ||
    lower.includes(`@${botUsername.toLowerCase()} deny`) ||
    lower.includes(`@${botUsername.toLowerCase()} undo`) ||
    lower.includes(`@${botUsername.toLowerCase()} try again`)
  );
}

function findLastTaskRequest(id: RepoId, branch: string, prNumber: number, botUsername: string): string | null {
  const events = readHistory(id, branch).slice().reverse();
  for (const e of events) {
    if (e.type !== "comment_detected") continue;
    if (e.pr !== prNumber) continue;
    const body = typeof e.body === "string" ? e.body : "";
    if (!body) continue;
    if (isControlComment(body, botUsername)) continue;
    return body;
  }
  return null;
}

async function resolveRepoAndBranch(rest: string[]): Promise<{ id: RepoId; branch: string; restAfterBranch: string[] }> {
  const explicit = rest[0] ? parseRepoArg(rest[0]) : null;
  if (explicit) {
    if (!hasExistingConfig(explicit)) {
      console.error(
        `${explicit.owner}/${explicit.repo} is not an initialized Buffalo repo.\n` +
        `Run \`buffalo init\` in the repo directory first.`
      );
      process.exit(1);
    }
    const branch = rest[1];
    if (!branch) {
      console.error("Branch is required when specifying owner/repo. Usage: buffalo <undo|retry> owner/repo <branch> [note]");
      process.exit(1);
    }
    return { id: explicit, branch, restAfterBranch: rest.slice(2) };
  }

  const id = requireRepo();
  const branch = rest[0] ?? getCurrentBranch();
  if (!branch) {
    console.error("No branch specified and unable to detect current branch.");
    process.exit(1);
  }
  return { id, branch, restAfterBranch: rest.slice(1) };
}

async function resolveOpenPrByBranch(id: RepoId, branch: string): Promise<{ number: number; branch: string; cloneUrl: string }> {
  const prs = await listOpenPRs(id);
  const pr = prs.find((p) => p.branch === branch);
  if (!pr) {
    throw new Error(`No open PR found for branch '${branch}'`);
  }
  return pr;
}

export async function dispatch(args: string[]): Promise<void> {
  const cmd = args[0];
  const rest = args.slice(1);

  switch (cmd) {
    case "init":
      await runInit();
      break;

    case "start": {
      // Internal flag: run in foreground (used by spawned background process)
      if (rest.includes("--_foreground")) {
        const repoArg = rest.find((a) => a !== "--_foreground");
        const id = repoArg ? parseRepoArg(repoArg) : null;
        if (!id) { console.error("Internal error: no repo for foreground mode"); process.exit(1); }
        writePidFile(id, process.pid);
        startPolling([id]);
        const handleFatal = (label: string, err: unknown) => {
          console.error(`[buffalo] ${label}:`, err);
          stopPolling();
          if (readPidFile(id) === process.pid) removePidFile(id);
          process.exit(1);
        };

        process.on("uncaughtException", (err) => {
          handleFatal("Uncaught exception", err);
        });

        process.on("unhandledRejection", (err) => {
          handleFatal("Unhandled promise rejection", err);
        });

        const cleanExit = () => {
          stopPolling();
          // Only remove the PID file if it still contains our own PID.
          // A restart may have already replaced it with the new daemon's PID.
          if (readPidFile(id) === process.pid) removePidFile(id);
          process.exit(0);
        };
        process.on("SIGINT", cleanExit);
        process.on("SIGTERM", cleanExit);
        break;
      }

      const repos = resolveTargetRepos(rest);
      for (const id of repos) {
        const existingPid = readPidFile(id);
        if (existingPid && isProcessRunning(existingPid)) {
          console.log(`${id.owner}/${id.repo}: already running (pid ${existingPid}) — use 'buffalo restart' to replace`);
          continue;
        } else if (existingPid) {
          removePidFile(id); // Stale PID file — process is gone
        }

        // Spawn a detached background process for this repo
        const logPath = path.join(repoDir(id), "logs", "daemon.log");
        const out = fs.openSync(logPath, "a");
        const child = spawn(
          process.argv[0],
          [process.argv[1], "start", "--_foreground", `${id.owner}/${id.repo}`],
          { detached: true, stdio: ["ignore", out, out] }
        );
        child.unref();
        console.log(`${id.owner}/${id.repo}: started in background (pid ${child.pid})`);
      }
      break;
    }

    case "restart": {
      const repos = resolveTargetRepos(rest);
      for (const id of repos) {
        const existingPid = readPidFile(id);
        if (existingPid && isProcessRunning(existingPid)) {
          try {
            process.kill(existingPid, "SIGTERM");
            removePidFile(id);
            console.log(`${id.owner}/${id.repo}: stopped old daemon (pid ${existingPid})`);
          } catch {
            console.warn(`${id.owner}/${id.repo}: could not stop pid ${existingPid}, continuing`);
          }
        } else if (existingPid) {
          removePidFile(id);
        }
        destroySession(id);

        const logPath = path.join(repoDir(id), "logs", "daemon.log");
        const out = fs.openSync(logPath, "a");
        const child = spawn(
          process.argv[0],
          [process.argv[1], "start", "--_foreground", `${id.owner}/${id.repo}`],
          { detached: true, stdio: ["ignore", out, out] }
        );
        child.unref();
        console.log(`${id.owner}/${id.repo}: restarted in background (pid ${child.pid})`);
      }
      break;
    }

    case "stop": {
      const repos = resolveTargetRepos(rest);
      for (const id of repos) {
        const pid = readPidFile(id);
        if (!pid || !isProcessRunning(pid)) {
          removePidFile(id);
          console.log(`${id.owner}/${id.repo}: not running`);
        } else {
          try {
            process.kill(pid, "SIGTERM");
            removePidFile(id);
            console.log(`${id.owner}/${id.repo}: stopped (pid ${pid})`);
          } catch (err) {
            console.error(`${id.owner}/${id.repo}: failed to stop (pid ${pid}):`, err);
          }
        }
        destroySession(id);
        console.log(`${id.owner}/${id.repo}: tmux session killed`);
      }
      break;
    }

    case "status": {
      const requestedRepo = rest[0] ? parseRepoArg(rest[0]) : null;
      if (rest[0] && !requestedRepo) {
        console.error("Usage: buffalo status [owner/repo]");
        process.exit(1);
      }

      const allRepos = getAllRepos();
      const repos = requestedRepo
        ? allRepos.filter((id) => id.owner === requestedRepo.owner && id.repo === requestedRepo.repo)
        : allRepos;

      if (requestedRepo && repos.length === 0) {
        console.error(`${requestedRepo.owner}/${requestedRepo.repo} is not an initialized Buffalo repo.`);
        process.exit(1);
      }

      const repoSnapshots = repos.map((id) => {
        const pid = readPidFile(id);
        return {
          id,
          pid,
          isPolling: pid !== null && isProcessRunning(pid),
          pollerState: getPollerStatus(id),
          sessions: loadSessions(id).sessions,
        };
      });
      console.log(renderStatusReport(repoSnapshots, getRecentPollerErrors(3), { detailed: Boolean(requestedRepo) }));
      break;
    }

    case "attach": {
      const branchArg = rest.find((a) => !a.startsWith("-"));

      const allWindows = listWindows();

      if (allWindows.length === 0) {
        console.error("[buffalo] No active sessions. Run 'buffalo start' first.");
        break;
      }

      // Narrow to repos that are both detected in cwd AND have a buffalo config.
      // If we're not in a git repo (no remotes), show all windows as fallback.
      const localRemotes = detectAllRemotes();
      const configuredSessions = new Set(
        localRemotes
          .filter((r) =>
            fs.existsSync(path.join(repoDir({ owner: r.owner, repo: r.repo }), "config.json"))
          )
          .map((r) => `buffalo-${r.owner}-${r.repo}`)
      );

      let candidates =
        configuredSessions.size > 0
          ? allWindows.filter((w) => configuredSessions.has(w.session))
          : allWindows;

      // Further filter by branch if one was specified
      if (branchArg) {
        candidates = candidates.filter((w) => w.window === branchArg);
      }

      if (candidates.length === 0) {
        if (branchArg) {
          console.error(`[buffalo] No session found for branch '${branchArg}'.`);
        } else {
          console.error("[buffalo] No active sessions for configured repos in this directory.");
        }
        break;
      }

      let chosen = candidates[0];

      if (candidates.length > 1) {
        // Multiple sessions — prompt the user to pick one
        console.log("Multiple active sessions:");
        candidates.forEach((w, i) =>
          console.log(`  ${i + 1}) ${w.session}:${w.window}${w.active ? " (active)" : ""}`)
        );
        const rl = (await import("node:readline")).createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await new Promise<string>((resolve) => {
          rl.question(`Attach to which? (1-${candidates.length}): `, (a) => {
            rl.close();
            resolve(a.trim());
          });
        });
        const idx = parseInt(answer, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= candidates.length) {
          console.error("Invalid selection.");
          break;
        }
        chosen = candidates[idx];
      }

      await attachToTarget(`${chosen.session}:${chosen.window}`);
      break;
    }

    case "pause": {
      const id = requireRepo();
      const branch = rest[0] ?? getCurrentBranch();
      if (!branch) { console.error("No branch specified"); break; }
      if (pauseSession(id, branch)) {
        console.log(`Paused ${branch}`);
      } else {
        console.log(`No active session for ${branch}`);
      }
      break;
    }

    case "resume": {
      const id = requireRepo();
      const branch = rest[0] ?? getCurrentBranch();
      if (!branch) { console.error("No branch specified"); break; }
      if (resumeSession(id, branch)) {
        console.log(`Resumed ${branch}`);
      } else {
        console.log(`No paused session for ${branch}`);
      }
      break;
    }

    case "fresh": {
      const id = requireRepo();
      const branch = rest[0] ?? getCurrentBranch();
      if (!branch) { console.error("No branch specified"); break; }
      clearBranchResumable(id, branch);
      console.log(`${branch}: next session will start fresh (codex context cleared)`);
      break;
    }

    case "undo": {
      const { id, branch } = await resolveRepoAndBranch(rest);
      try {
        const pr = await resolveOpenPrByBranch(id, branch);
        const cwd = ensureWorkspace(id, branch, pr.cloneUrl);
        void cwd;
        const newHead = rollbackLastCommit(id, branch);
        console.log(`${id.owner}/${id.repo} ${branch}: rolled back last commit, new HEAD ${newHead}`);
      } catch (err: any) {
        console.error(`Undo failed: ${err?.message ?? err}`);
        process.exit(1);
      }
      break;
    }

    case "retry": {
      const { id, branch, restAfterBranch } = await resolveRepoAndBranch(rest);
      const note = restAfterBranch.join(" ").trim();
      try {
        const cfg = loadRepoConfig(id);
        const pr = await resolveOpenPrByBranch(id, branch);
        const cwd = ensureWorkspace(id, branch, pr.cloneUrl);
        const newHead = rollbackLastCommit(id, branch);
        const original = findLastTaskRequest(id, branch, pr.number, cfg.botUsername);
        const originalBody = original
          ? original.replace(new RegExp(`@${cfg.botUsername}`, "gi"), "").trim()
          : "(original request not found in history)";
        const retryBody = [
          `@${cfg.botUsername} Retry the previous request using a different approach.`,
          `Original request: ${originalBody}`,
          note ? `Additional guidance: ${note}` : null,
        ].filter(Boolean).join("\n");
        const prompt = buildPrompt({
          prNumber: pr.number,
          branch,
          comments: [{
            id: Date.now(),
            body: retryBody,
            user: "manual",
            prNumber: pr.number,
            createdAt: new Date().toISOString(),
            htmlUrl: "",
            commentType: "issue",
          }],
        }, `@${cfg.botUsername}`);

        startCliSession(id, branch, prompt, cwd, pr.number);
        setSession(id, branch, {
          branch,
          prNumber: pr.number,
          commentIds: [],
          triggerComments: [{
            user: "manual",
            body: note ? `retry: ${note}` : "retry",
          }],
          status: "running",
          logOffset: 0,
        });

        console.log(`${id.owner}/${id.repo} ${branch}: rolled back to ${newHead} and started retry session`);
      } catch (err: any) {
        console.error(`Retry failed: ${err?.message ?? err}`);
        process.exit(1);
      }
      break;
    }

    case "list": {
      const windows = listWindows();
      if (windows.length === 0) {
        console.log("No active tmux windows.");
      } else {
        for (const w of windows) {
          console.log(`  ${w.session}:${w.window}${w.active ? " (active)" : ""}`);
        }
      }
      break;
    }

    case "logs": {
      const id = requireRepo();
      const branch = rest[0] ?? getCurrentBranch();
      if (!branch) { console.error("No branch specified"); break; }
      const log = logFile(id, branch);
      if (!fs.existsSync(log)) {
        console.log(`No log file for ${branch}`);
      } else {
        // Tail the log
        try {
          execSync(`tail -f ${log}`, { stdio: "inherit" });
        } catch {}
      }
      break;
    }

    case "history": {
      const id = requireRepo();
      const branch = rest[0] ?? getCurrentBranch();
      if (!branch) { console.error("No branch specified"); break; }
      const events = readHistory(id, branch);
      if (events.length === 0) {
        console.log(`No history for ${branch}`);
      } else {
        for (const e of events) {
          console.log(`${e.ts} [${e.type}] ${JSON.stringify(e)}`);
        }
      }
      break;
    }

    case "whitelist": {
      const subcmd = rest[0];
      if (!subcmd) {
        const id = detectRepoFromCwd();
        const patterns = loadWhitelist(id ?? undefined);
        console.log("Command whitelist:");
        patterns.forEach((p, i) => console.log(`  ${i}: ${p}`));
        break;
      }
      if (subcmd === "add") {
        const pattern = rest[1];
        if (!pattern) { console.error("Usage: buffalo whitelist add <pattern>"); break; }
        const current = loadWhitelist();
        if (!current.includes(pattern)) {
          saveGlobalWhitelist([...current, pattern]);
          console.log(`Added pattern: ${pattern}`);
        } else {
          console.log("Pattern already exists.");
        }
        break;
      }
      if (subcmd === "remove") {
        const idx = parseInt(rest[1], 10);
        if (isNaN(idx)) { console.error("Usage: buffalo whitelist remove <index>"); break; }
        const current = loadWhitelist();
        if (idx < 0 || idx >= current.length) { console.error("Index out of range"); break; }
        const removed = current.splice(idx, 1);
        saveGlobalWhitelist(current);
        console.log(`Removed pattern: ${removed[0]}`);
        break;
      }
      console.error(`Unknown whitelist command: ${subcmd}`);
      break;
    }

    default:
      console.log(`Buffalo — GitHub PR Collaborator Bot

Usage:
  buffalo init                        Set up a repo
  buffalo start [owner/repo]          Start polling in background
  buffalo restart [owner/repo]        Stop existing daemon and start fresh
  buffalo stop [owner/repo]           Stop polling
  buffalo status                      Show repos and sessions
  buffalo attach [branch]             Attach to tmux window
  buffalo pause [branch]              Pause a session
  buffalo resume [branch]             Resume a session
  buffalo fresh [branch]              Clear codex context — next session starts fresh
  buffalo undo [owner/repo] [branch] Roll back latest commit on PR branch
  buffalo retry [owner/repo] [branch] [note]
                                     Roll back latest commit and rerun with retry guidance
  buffalo list                        List active tmux windows
  buffalo logs [branch]               Tail log for a branch
  buffalo history [branch]            Show action history
  buffalo whitelist                   Show command whitelist
  buffalo whitelist add <pat>         Add whitelist pattern
  buffalo whitelist remove <i>        Remove pattern by index
`);
  }
}
