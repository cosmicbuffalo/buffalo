import { type RepoId, workspaceDir } from "./config.js";
import { readHistory } from "./history.js";

/**
 * Replace local workspace file paths in markdown links with GitHub blob URLs.
 * Codex writes links using the absolute local workspace path; we rewrite them
 * to https://github.com/<owner>/<repo>/blob/<branch>/<relative-path>.
 */
export function rewriteLocalPaths(text: string, id: RepoId, branch: string): string {
  const base = workspaceDir(id, branch);
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Rewrite markdown links with local paths to GitHub blob URLs
  let result = text.replace(
    new RegExp(`\\[([^\\]]+)\\]\\(${escaped}/([^)]+)\\)`, "g"),
    (_, linkText, relPath) =>
      `[${linkText}](https://github.com/${id.owner}/${id.repo}/blob/${branch}/${relPath})`
  );

  // Strip the workspace prefix from any remaining bare paths, leaving just the relative path
  result = result.replace(new RegExp(`${escaped}/`, "g"), "");

  return result;
}

export function isUndoCommand(body: string, botUsername: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes(`@${botUsername.toLowerCase()} undo`);
}

export function isTryAgainCommand(body: string, botUsername: string): boolean {
  const lower = body.toLowerCase();
  const bot = `@${botUsername.toLowerCase()}`;
  return lower.includes(`${bot} try again`) || lower.includes(`${bot} retry`);
}

export function extractTryAgainNote(body: string): string | null {
  const match = body.match(/(?:try again|retry)[:\s-]*(.*)$/i);
  const note = match?.[1]?.trim() ?? "";
  return note.length > 0 ? note : null;
}

/**
 * Find the comment ID of the last comment posted by the bot on a given branch/PR.
 * Used by try-again and undo to delete the stale response before retrying.
 */
export function findLastBotCommentId(id: RepoId, branch: string, prNumber: number): number | null {
  const events = readHistory(id, branch).slice().reverse();
  for (const e of events) {
    if (e.type !== "comment_posted") continue;
    if (e.pr !== prNumber) continue;
    if (typeof e.comment_id === "number") return e.comment_id;
  }
  return null;
}
