import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createTestHome, freshImport, writeJson } from "./helpers.js";

describe("repo-manager", () => {
  let env: ReturnType<typeof createTestHome>;
  const repoId = { owner: "test", repo: "repo" };
  let bareRepoPath: string;

  beforeEach(() => {
    env = createTestHome();

    const repoPath = path.join(env.buffaloDir, "repos", "test", "repo");
    writeJson(path.join(repoPath, "config.json"), {
      botTag: "@bot",
      authorizedUsers: ["alice"],
      backend: "claude",
      pollIntervalMs: 60000,
    });
    fs.mkdirSync(path.join(repoPath, "history"), { recursive: true });

    // Create a bare git repo to clone from
    bareRepoPath = path.join(env.home, "bare-repo.git");
    execSync(`git init --bare ${bareRepoPath}`, { stdio: "pipe" });

    // Create initial commit via temp clone
    const tmpClone = path.join(env.home, "tmp-clone");
    execSync(`git clone ${bareRepoPath} ${tmpClone}`, { stdio: "pipe" });
    execSync("git checkout -b main", { cwd: tmpClone, stdio: "pipe" });
    execSync("git config user.email test@test.com && git config user.name Test", {
      cwd: tmpClone, stdio: "pipe",
    });
    fs.writeFileSync(path.join(tmpClone, "README.md"), "# Test\n");
    execSync("git add -A && git commit -m init", { cwd: tmpClone, stdio: "pipe" });
    execSync("git push origin main", { cwd: tmpClone, stdio: "pipe" });
    fs.rmSync(tmpClone, { recursive: true, force: true });
  });
  afterEach(() => env.cleanup());

  describe("ensureWorkspace", () => {
    it("clones a branch into the workspace directory", async () => {
      const manager = await freshImport<typeof import("../src/repo-manager.js")>(
        "../src/repo-manager.js"
      );
      const dir = manager.ensureWorkspace(repoId, "main", bareRepoPath);
      assert.ok(fs.existsSync(dir));
      assert.ok(fs.existsSync(path.join(dir, ".git")));
      assert.ok(fs.existsSync(path.join(dir, "README.md")));
    });

    it("pulls latest on subsequent calls", async () => {
      const manager = await freshImport<typeof import("../src/repo-manager.js")>(
        "../src/repo-manager.js"
      );

      const dir = manager.ensureWorkspace(repoId, "main", bareRepoPath);

      // Push a new commit via temp clone
      const tmpClone = path.join(env.home, "tmp-clone2");
      execSync(`git clone ${bareRepoPath} ${tmpClone}`, { stdio: "pipe" });
      execSync("git checkout main", { cwd: tmpClone, stdio: "pipe" });
      execSync("git config user.email test@test.com && git config user.name Test", {
        cwd: tmpClone, stdio: "pipe",
      });
      fs.writeFileSync(path.join(tmpClone, "new-file.txt"), "new\n");
      execSync("git add -A && git commit -m 'add file'", { cwd: tmpClone, stdio: "pipe" });
      execSync("git push origin main", { cwd: tmpClone, stdio: "pipe" });
      fs.rmSync(tmpClone, { recursive: true, force: true });

      manager.ensureWorkspace(repoId, "main", bareRepoPath);
      assert.ok(fs.existsSync(path.join(dir, "new-file.txt")));
    });
  });

  describe("commitAndPush", () => {
    it("returns null when there are no changes", async () => {
      const manager = await freshImport<typeof import("../src/repo-manager.js")>(
        "../src/repo-manager.js"
      );
      manager.ensureWorkspace(repoId, "main", bareRepoPath);
      const sha = manager.commitAndPush(repoId, "main", "no changes");
      assert.equal(sha, null);
    });

    it("commits and pushes changes", async () => {
      const manager = await freshImport<typeof import("../src/repo-manager.js")>(
        "../src/repo-manager.js"
      );
      const dir = manager.ensureWorkspace(repoId, "main", bareRepoPath);

      // Set git config in workspace
      execSync("git config user.email test@test.com && git config user.name Test", {
        cwd: dir, stdio: "pipe",
      });

      fs.writeFileSync(path.join(dir, "change.txt"), "hello\n");
      const sha = manager.commitAndPush(repoId, "main", "buffalo: test commit");
      assert.ok(sha);
      assert.ok(sha.length > 0);

      // Verify pushed
      const verifyDir = path.join(env.home, "verify");
      execSync(`git clone --branch main ${bareRepoPath} ${verifyDir}`, { stdio: "pipe" });
      assert.ok(fs.existsSync(path.join(verifyDir, "change.txt")));
    });
  });
});
