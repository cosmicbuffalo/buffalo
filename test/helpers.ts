import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export function createTestHome(): { home: string; buffaloDir: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "buffalo-test-"));
  const buffaloDir = path.join(home, ".buffalo");
  fs.mkdirSync(buffaloDir, { recursive: true });

  const origHome = process.env.HOME;
  process.env.HOME = home;

  return {
    home,
    buffaloDir,
    cleanup: () => {
      process.env.HOME = origHome;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

let importCounter = 0;

/**
 * Import a fresh copy of a module (bypasses ESM cache).
 * All modules imported with the same counter share state.
 */
export function nextImportId(): number {
  return ++importCounter;
}

export async function freshImport<T>(modulePath: string, id?: number): Promise<T> {
  const counter = id ?? nextImportId();
  return import(`${modulePath}?t=${counter}`) as Promise<T>;
}

/**
 * Import multiple modules sharing the same cache-bust ID so they
 * see each other's singletons (e.g., BUFFALO_DIR).
 */
export async function freshImportAll(id?: number) {
  const counter = id ?? nextImportId();
  const imp = <T>(p: string) => import(`${p}?t=${counter}`) as Promise<T>;
  return {
    config: await imp<typeof import("../src/config.js")>("../src/config.js"),
    history: await imp<typeof import("../src/history.js")>("../src/history.js"),
    sessionStore: await imp<typeof import("../src/session-store.js")>("../src/session-store.js"),
    commandGuard: await imp<typeof import("../src/command-guard.js")>("../src/command-guard.js"),
    cliRunner: await imp<typeof import("../src/cli-runner.js")>("../src/cli-runner.js"),
    batch: await imp<typeof import("../src/batch.js")>("../src/batch.js"),
  };
}

export function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}
