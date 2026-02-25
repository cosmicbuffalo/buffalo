import * as fs from "node:fs";
import * as path from "node:path";
import { type RepoId, repoDir, ensureDir } from "./config.js";

export interface SessionInfo {
  branch: string;
  prNumber: number;
  commentIds: number[];
  status: "running" | "waiting_approval" | "completed" | "paused";
  logOffset: number;
  pendingApproval?: {
    command: string;
    failedPart: string;
    commentId?: number;
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

// Last poll timestamp
export function loadLastPoll(id: RepoId): string | null {
  const file = path.join(repoDir(id), "last_poll.json");
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return data.lastPoll ?? null;
  } catch {
    return null;
  }
}

export function saveLastPoll(id: RepoId, ts: string): void {
  const file = path.join(repoDir(id), "last_poll.json");
  ensureDir(repoDir(id));
  fs.writeFileSync(file, JSON.stringify({ lastPoll: ts }) + "\n");
}
