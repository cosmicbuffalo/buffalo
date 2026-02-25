import { type RepoId, loadWhitelist, loadGlobalConfig, saveGlobalWhitelist, saveRepoWhitelist } from "./config.js";

export interface CheckResult {
  approved: boolean;
  /** The subcommand that failed, if any */
  failedPart?: string;
}

/**
 * Split compound shell commands into individual parts.
 * Handles &&, ||, ;, | and $() / backtick subshells.
 */
export function splitCommand(cmd: string): string[] {
  // Replace subshell markers with separators for independent checking
  let normalized = cmd
    .replace(/\$\(([^)]+)\)/g, (_m, inner) => `__SUBCMD__${inner}__SUBCMD__`)
    .replace(/`([^`]+)`/g, (_m, inner) => `__SUBCMD__${inner}__SUBCMD__`);

  // Split on &&, ||, ;, |
  const parts: string[] = [];
  const rawParts = normalized.split(/\s*(?:&&|\|\||[;|])\s*/);

  for (const part of rawParts) {
    if (part.includes("__SUBCMD__")) {
      const subParts = part.split("__SUBCMD__").filter(Boolean);
      for (const sp of subParts) {
        const trimmed = sp.trim();
        if (trimmed) parts.push(trimmed);
      }
    } else {
      const trimmed = part.trim();
      if (trimmed) parts.push(trimmed);
    }
  }

  return parts;
}

/**
 * Check if a command is allowed by the whitelist.
 */
export function checkCommand(command: string, repoId?: RepoId): CheckResult {
  const patterns = loadWhitelist(repoId);
  const parts = splitCommand(command);

  for (const part of parts) {
    const allowed = patterns.some((pat) => {
      try {
        return new RegExp(pat).test(part);
      } catch {
        return false;
      }
    });
    if (!allowed) {
      return { approved: false, failedPart: part };
    }
  }

  return { approved: true };
}

/**
 * Add a pattern to the global whitelist.
 */
export function addGlobalPattern(pattern: string): void {
  const current = loadWhitelist();
  if (!current.includes(pattern)) {
    saveGlobalWhitelist([...current, pattern]);
  }
}

/**
 * Add a pattern to a repo whitelist.
 */
export function addRepoPattern(id: RepoId, pattern: string): void {
  const current = loadWhitelist(id);
  const globalPatterns = loadWhitelist();
  const repoPatterns = current.filter((p: string) => !globalPatterns.includes(p));
  if (!repoPatterns.includes(pattern)) {
    saveRepoWhitelist(id, [...repoPatterns, pattern]);
  }
}
