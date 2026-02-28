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
import { pauseSession, resumeSession, loadSessions, clearBranchResumable } from "./session-store.js";
import { readHistory } from "./history.js";
import { startPolling, stopPolling } from "./poller.js";
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
      const repos = getAllRepos();
      if (repos.length === 0) {
        console.log("No repos configured. Run `buffalo init`.");
        break;
      }
      for (const id of repos) {
        const pid = readPidFile(id);
        const polling = pid && isProcessRunning(pid) ? `polling (pid ${pid})` : "not polling";
        console.log(`\n${id.owner}/${id.repo}: [${polling}]`);
        const sessions = loadSessions(id);
        const entries = Object.entries(sessions.sessions);
        if (entries.length === 0) {
          console.log("  No active sessions");
        } else {
          for (const [branch, s] of entries) {
            console.log(`  ${branch}: PR #${s.prNumber} [${s.status}]`);
          }
        }
      }
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
  buffalo list                        List active tmux windows
  buffalo logs [branch]               Tail log for a branch
  buffalo history [branch]            Show action history
  buffalo whitelist                   Show command whitelist
  buffalo whitelist add <pat>         Add whitelist pattern
  buffalo whitelist remove <i>        Remove pattern by index
`);
  }
}
