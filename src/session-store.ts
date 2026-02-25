import * as fs from "node:fs";
import * as path from "node:path";
import { type RepoId, repoDir, ensureDir } from "./config.js";

export interface TriggerComment {
  user: string;
  body: string;
}

export interface SessionInfo {
  branch: string;
  prNumber: number;
  commentIds: number[];
  triggerComments?: TriggerComment[];
  status: "running" | "waiting_approval" | "waiting_clarification" | "completed" | "paused";
  logOffset: number;
  pendingApproval?: {
    command: string;
    failedPart: string;
    commentId?: number;
  };
  pendingClarification?: {
    question: string;
    commentId: number;
  };
}

export interface SessionStore {
  sessions: Record<string, SessionInfo>;
}

function storeFile(id: RepoId): string {
  return path.join(repoDir(id), "sessions.json");
}

export function loadSessions(id: RepoId): SessionStore {
  const file = storeFile(id);
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return { sessions: {} };
  }
}

export function saveSessions(id: RepoId, store: SessionStore): void {
  ensureDir(repoDir(id));
  fs.writeFileSync(storeFile(id), JSON.stringify(store, null, 2) + "\n");
}

export function getSession(id: RepoId, branch: string): SessionInfo | undefined {
  return loadSessions(id).sessions[branch];
}

export function setSession(id: RepoId, branch: string, info: SessionInfo): void {
  const store = loadSessions(id);
  store.sessions[branch] = info;
  saveSessions(id, store);
}

export function removeSession(id: RepoId, branch: string): void {
  const store = loadSessions(id);
  delete store.sessions[branch];
  saveSessions(id, store);
}

export function pauseSession(id: RepoId, branch: string): boolean {
  const session = getSession(id, branch);
  if (!session) return false;
  session.status = "paused";
  setSession(id, branch, session);
  return true;
}

export function resumeSession(id: RepoId, branch: string): boolean {
  const session = getSession(id, branch);
  if (!session || session.status !== "paused") return false;
  session.status = "running";
  setSession(id, branch, session);
  return true;
}

// ── Codex resume state ────────────────────────────────────────────────────────
// Tracks which branches have an unresolved codex session that should be resumed
// when the next comment arrives.  Cleared when a commit is pushed (= resolved).

function resumeStateFile(id: RepoId): string {
  return path.join(repoDir(id), "resume-state.json");
}

interface ResumeState {
  resumableBranches: string[];
}

function loadResumeState(id: RepoId): ResumeState {
  try {
    return JSON.parse(fs.readFileSync(resumeStateFile(id), "utf-8"));
  } catch {
    return { resumableBranches: [] };
  }
}

function saveResumeState(id: RepoId, state: ResumeState): void {
  ensureDir(repoDir(id));
  fs.writeFileSync(resumeStateFile(id), JSON.stringify(state, null, 2) + "\n");
}

/** Returns true if the last session on this branch ended without a commit push. */
export function shouldResumeBranch(id: RepoId, branch: string): boolean {
  return loadResumeState(id).resumableBranches.includes(branch);
}

/** Mark a branch as having an unresolved session (no commit was pushed). */
export function markBranchResumable(id: RepoId, branch: string): void {
  const state = loadResumeState(id);
  if (!state.resumableBranches.includes(branch)) {
    state.resumableBranches.push(branch);
    saveResumeState(id, state);
  }
}

/** Clear resume state for a branch (commit was pushed, or session failed). */
export function clearBranchResumable(id: RepoId, branch: string): void {
  const state = loadResumeState(id);
  const idx = state.resumableBranches.indexOf(branch);
  if (idx !== -1) {
    state.resumableBranches.splice(idx, 1);
    saveResumeState(id, state);
  }
}

// ── Seen comment IDs ──────────────────────────────────────────────────────────
// Used to avoid re-processing comments across poll cycles
function seenCommentsFile(id: RepoId): string {
  return path.join(repoDir(id), "seen_comments.json");
}

export function loadSeenCommentIds(id: RepoId): Set<number> {
  try {
    const data = JSON.parse(fs.readFileSync(seenCommentsFile(id), "utf-8"));
    return new Set<number>(data.ids ?? []);
  } catch {
    return new Set<number>();
  }
}

export function saveSeenCommentIds(id: RepoId, seen: Set<number>): void {
  ensureDir(repoDir(id));
  fs.writeFileSync(seenCommentsFile(id), JSON.stringify({ ids: [...seen] }) + "\n");
}
