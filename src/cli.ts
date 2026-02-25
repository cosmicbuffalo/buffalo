import { execSync } from "node:child_process";
import * as fs from "node:fs";
import {
  type RepoId,
  detectRepoFromCwd,
  getAllRepos,
  loadWhitelist,
  saveGlobalWhitelist,
  loadRepoConfig,
  logFile,
} from "./config.js";
import { attachToWindow, listWindows } from "./tmux-manager.js";
import { pauseSession, resumeSession, loadSessions } from "./session-store.js";
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

export async function dispatch(args: string[]): Promise<void> {
  const cmd = args[0];
  const rest = args.slice(1);

  switch (cmd) {
    case "init":
      await runInit();
      break;

    case "start": {
      const id = detectRepoFromCwd();
      const repos = id ? [id] : getAllRepos();
      startPolling(repos);
      // Keep process alive
      process.on("SIGINT", () => { stopPolling(); process.exit(0); });
      process.on("SIGTERM", () => { stopPolling(); process.exit(0); });
      break;
    }

    case "stop":
      stopPolling();
      break;

    case "status": {
      const repos = getAllRepos();
      if (repos.length === 0) {
        console.log("No repos configured. Run `buffalo init`.");
        break;
      }
      for (const id of repos) {
        console.log(`\n${id.owner}/${id.repo}:`);
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
      const id = rest.includes("--repo")
        ? (() => {
            const idx = rest.indexOf("--repo");
            const [owner, repo] = rest[idx + 1].split("/");
            return { owner, repo };
          })()
        : requireRepo();

      const branch = rest.find((a) => !a.startsWith("-")) ?? getCurrentBranch();
      attachToWindow(id, branch ?? undefined);
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
  buffalo init                  Set up a repo
  buffalo start                 Start polling
  buffalo stop                  Stop polling
  buffalo status                Show repos and sessions
  buffalo attach [branch]       Attach to tmux window
  buffalo pause [branch]        Pause a session
  buffalo resume [branch]       Resume a session
  buffalo list                  List active tmux windows
  buffalo logs [branch]         Tail log for a branch
  buffalo history [branch]      Show action history
  buffalo whitelist             Show command whitelist
  buffalo whitelist add <pat>   Add whitelist pattern
  buffalo whitelist remove <i>  Remove pattern by index
`);
  }
}
