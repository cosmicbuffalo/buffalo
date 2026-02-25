import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { type RepoId, workspaceDir, ensureDir, loadGlobalConfig, loadRepoConfig } from "./config.js";
import { appendHistory } from "./history.js";
import { destroyWindow } from "./tmux-manager.js";
import { removeSession } from "./session-store.js";
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

  // Build clone URL with token for auth
  const token = loadRepoConfig(id).githubToken || loadGlobalConfig().githubToken;
  let authUrl = cloneUrl;
  if (token && cloneUrl.startsWith("https://")) {
    authUrl = cloneUrl.replace("https://", `https://x-access-token:${token}@`);
  }

  run(
    `git clone --depth=1 --single-branch --branch ${branch} ${authUrl} ${dir}`
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

  // Remove session tracking
  removeSession(id, branch);

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
