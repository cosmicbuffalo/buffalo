import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

export interface RepoId {
  owner: string;
  repo: string;
}

export interface GlobalConfig {
  githubToken: string;
  authorizedUsers: string[];
  defaultBackend: "claude" | "codex";
  pollIntervalMs: number;
}

export interface RepoConfig {
  botTag: string;
  authorizedUsers: string[];
  backend: "claude" | "codex";
  pollIntervalMs: number;
  githubToken?: string;
}

export interface WhitelistConfig {
  patterns: string[];
}

function getBuffaloDir(): string {
  return path.join(os.homedir(), ".buffalo");
}

export function buffaloDir(): string {
  return getBuffaloDir();
}

export function repoDir(id: RepoId): string {
  return path.join(getBuffaloDir(), "repos", id.owner, id.repo);
}

export function workspaceDir(id: RepoId, branch: string): string {
  return path.join(repoDir(id), "workspaces", branch);
}

export function logDir(id: RepoId): string {
  return path.join(repoDir(id), "logs");
}

export function historyDir(id: RepoId): string {
  return path.join(repoDir(id), "history");
}

export function logFile(id: RepoId, branch: string): string {
  return path.join(logDir(id), `${branch}.log`);
}

export function historyFile(id: RepoId, branch: string): string {
  return path.join(historyDir(id), `${branch}.jsonl`);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

const DEFAULT_GLOBAL: GlobalConfig = {
  githubToken: "",
  authorizedUsers: [],
  defaultBackend: "claude",
  pollIntervalMs: 15 * 60 * 1000,
};

export function loadGlobalConfig(): GlobalConfig {
  return readJson(path.join(getBuffaloDir(), "config.json"), DEFAULT_GLOBAL);
}

export function saveGlobalConfig(cfg: GlobalConfig): void {
  writeJson(path.join(getBuffaloDir(), "config.json"), cfg);
}

export function loadRepoConfig(id: RepoId): RepoConfig {
  const global = loadGlobalConfig();
  const defaults: RepoConfig = {
    botTag: "@buffalo",
    authorizedUsers: global.authorizedUsers,
    backend: global.defaultBackend,
    pollIntervalMs: global.pollIntervalMs,
  };
  const repo = readJson<Partial<RepoConfig>>(
    path.join(repoDir(id), "config.json"),
    {}
  );
  return { ...defaults, ...repo };
}

export function saveRepoConfig(id: RepoId, cfg: RepoConfig): void {
  writeJson(path.join(repoDir(id), "config.json"), cfg);
}

export function loadWhitelist(id?: RepoId): string[] {
  const globalWl = readJson<WhitelistConfig>(
    path.join(getBuffaloDir(), "whitelist.json"),
    { patterns: [] }
  );
  if (!id) return globalWl.patterns;
  const repoWl = readJson<WhitelistConfig>(
    path.join(repoDir(id), "whitelist.json"),
    { patterns: [] }
  );
  return [...globalWl.patterns, ...repoWl.patterns];
}

export function saveGlobalWhitelist(patterns: string[]): void {
  writeJson(path.join(getBuffaloDir(), "whitelist.json"), { patterns });
}

export function saveRepoWhitelist(id: RepoId, patterns: string[]): void {
  writeJson(path.join(repoDir(id), "whitelist.json"), { patterns });
}

const DEFAULT_SAFE_PATTERNS = [
  "^git\\s+(status|diff|log|show|branch)",
  "^ls\\b",
  "^cat\\b",
  "^head\\b",
  "^tail\\b",
  "^find\\b",
  "^grep\\b",
  "^rg\\b",
  "^wc\\b",
  "^file\\b",
  "^which\\b",
  "^echo\\b",
  "^npm\\s+(test|run|install)\\b",
  "^node\\b",
  "^npx\\b",
  "^python[23]?\\b",
  "^pip[23]?\\s+install\\b",
  "^sed\\b",
  "^awk\\b",
  "^mkdir\\b",
  "^touch\\b",
  "^cp\\b",
  "^mv\\b",
];

export function initBuffaloDir(): void {
  ensureDir(getBuffaloDir());
  const wlPath = path.join(getBuffaloDir(), "whitelist.json");
  if (!fs.existsSync(wlPath)) {
    writeJson(wlPath, { patterns: DEFAULT_SAFE_PATTERNS });
  }
}

export function detectRepoFromCwd(): RepoId | null {
  try {
    const remote = execSync("git remote get-url origin", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (match) return { owner: match[1], repo: match[2] };
  } catch {}
  return null;
}

export function getAllRepos(): RepoId[] {
  const reposRoot = path.join(getBuffaloDir(), "repos");
  if (!fs.existsSync(reposRoot)) return [];
  const repos: RepoId[] = [];
  for (const owner of fs.readdirSync(reposRoot)) {
    const ownerDir = path.join(reposRoot, owner);
    if (!fs.statSync(ownerDir).isDirectory()) continue;
    for (const repo of fs.readdirSync(ownerDir)) {
      const rd = path.join(ownerDir, repo);
      if (fs.statSync(rd).isDirectory() && fs.existsSync(path.join(rd, "config.json"))) {
        repos.push({ owner, repo });
      }
    }
  }
  return repos;
}
