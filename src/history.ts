import * as fs from "node:fs";
import { type RepoId, historyFile, ensureDir, historyDir } from "./config.js";

export interface HistoryEvent {
  ts: string;
  type: string;
  pr?: number;
  [key: string]: unknown;
}

export function appendHistory(
  id: RepoId,
  branch: string,
  event: Omit<HistoryEvent, "ts"> & { type: string }
): void {
  ensureDir(historyDir(id));
  const entry: HistoryEvent = { ts: new Date().toISOString(), ...event };
  fs.appendFileSync(historyFile(id, branch), JSON.stringify(entry) + "\n");
}

export function readHistory(id: RepoId, branch: string): HistoryEvent[] {
  const file = historyFile(id, branch);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
