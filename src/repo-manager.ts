import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { type RepoId, workspaceDir, ensureDir } from "./config.js";
import { appendHistory } from "./history.js";
import { destroyWindow } from "./tmux-manager.js";
import { removeSession, clearBranchResumable } from "./session-store.js";
import { getPullRequest } from "./github.js";

function run(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e: any) {
    throw new Error(`Command failed: ${cmd}\n${e.stderr || e.message}`);
  }
}

/**
 * Ensure a branch workspace exists. Clone if needed, pull if already cloned.
 */
export function ensureWorkspace(
  id: RepoId,
  branch: string,
  cloneUrl: string
): string {
  const dir = workspaceDir(id, branch);

  if (fs.existsSync(dir) && fs.existsSync(`${dir}/.git`)) {
    // Already cloned — pull latest
    run("git fetch origin", dir);
    run(`git reset --hard origin/${branch}`, dir);
    return dir;
  }

  ensureDir(dir);

  // Convert HTTPS clone URL to SSH so git uses the machine's existing SSH key
  // rather than needing a PAT embedded in the URL.
  // https://github.com/owner/repo.git  →  git@github.com:owner/repo.git
  const sshUrl = cloneUrl.replace(/^https:\/\/([^/]+)\//, "git@$1:");

  run(
    `git clone --depth=1 --single-branch --branch ${branch} ${sshUrl} ${dir}`
  );

  return dir;
}

/**
 * Stage all, commit, and push changes for a branch workspace.
 */
export function commitAndPush(
  id: RepoId,
  branch: string,
  message: string
): string | null {
  const dir = workspaceDir(id, branch);
  const status = run("git status --porcelain", dir);
  if (!status) return null; // No changes

  run("git add -A", dir);
  const escaped = message.replace(/"/g, '\\"');
  run(`git commit -m "${escaped}"`, dir);
  run("git push", dir);

  const sha = run("git rev-parse --short HEAD", dir);
  return sha;
}

/**
 * Check if a PR has been merged and perform cleanup.
 */
export async function checkAndCleanupMergedPR(
  id: RepoId,
  prNumber: number,
  branch: string
): Promise<boolean> {
  const pr = await getPullRequest(id, prNumber);
  if (!pr.merged && pr.state !== "closed") return false;

  appendHistory(id, branch, {
    type: pr.merged ? "pr_merged" : "pr_closed",
    pr: prNumber,
    branch,
  });

  // Destroy tmux window
  destroyWindow(id, branch);

  // Remove session tracking and clear codex resume state
  removeSession(id, branch);
  clearBranchResumable(id, branch);

  // Optionally remove workspace (keep history)
  const dir = workspaceDir(id, branch);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  appendHistory(id, branch, {
    type: "cleanup",
    pr: prNumber,
    branch,
    tmux_window_destroyed: true,
  });

  return true;
}
