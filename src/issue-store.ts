import * as fs from "node:fs";
import * as path from "node:path";
import { type RepoId, repoDir, ensureDir } from "./config.js";

// ── Seen issue IDs ────────────────────────────────────────────────────────────
// Tracks issue numbers (body mentions) that have been processed
function seenIssuesFile(id: RepoId): string {
  return path.join(repoDir(id), "seen_issues.json");
}

export function loadSeenIssueIds(id: RepoId): Set<number> {
  try {
    const data = JSON.parse(fs.readFileSync(seenIssuesFile(id), "utf-8"));
    return new Set<number>(data.ids ?? []);
  } catch {
    return new Set<number>();
  }
}

export function saveSeenIssueIds(id: RepoId, seen: Set<number>): void {
  ensureDir(repoDir(id));
  fs.writeFileSync(seenIssuesFile(id), JSON.stringify({ ids: [...seen] }) + "\n");
}

// ── Seen issue comment IDs ────────────────────────────────────────────────────
// Tracks issue comment IDs that have been processed
function seenIssueCommentsFile(id: RepoId): string {
  return path.join(repoDir(id), "seen_issue_comments.json");
}

export function loadSeenIssueCommentIds(id: RepoId): Set<number> {
  try {
    const data = JSON.parse(fs.readFileSync(seenIssueCommentsFile(id), "utf-8"));
    return new Set<number>(data.ids ?? []);
  } catch {
    return new Set<number>();
  }
}

export function saveSeenIssueCommentIds(id: RepoId, seen: Set<number>): void {
  ensureDir(repoDir(id));
  fs.writeFileSync(seenIssueCommentsFile(id), JSON.stringify({ ids: [...seen] }) + "\n");
}

// ── Issue → PR mapping ────────────────────────────────────────────────────────
// Maps issue numbers to the PR and branch created to address them
interface IssuePrEntry {
  prNumber: number;
  branch: string;
}

type IssuePrMap = Record<string, IssuePrEntry>;

function issuePrMapFile(id: RepoId): string {
  return path.join(repoDir(id), "issue-pr-map.json");
}

export function loadIssuePrMap(id: RepoId): IssuePrMap {
  try {
    return JSON.parse(fs.readFileSync(issuePrMapFile(id), "utf-8"));
  } catch {
    return {};
  }
}

export function saveIssuePrMap(id: RepoId, map: IssuePrMap): void {
  ensureDir(repoDir(id));
  fs.writeFileSync(issuePrMapFile(id), JSON.stringify(map, null, 2) + "\n");
}

export function getIssuePr(
  id: RepoId,
  issueNumber: number
): { prNumber: number; branch: string } | undefined {
  return loadIssuePrMap(id)[String(issueNumber)];
}

export function setIssuePr(
  id: RepoId,
  issueNumber: number,
  prNumber: number,
  branch: string
): void {
  const map = loadIssuePrMap(id);
  map[String(issueNumber)] = { prNumber, branch };
  saveIssuePrMap(id, map);
}
