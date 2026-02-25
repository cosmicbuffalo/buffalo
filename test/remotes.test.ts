import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createTestHome } from "./helpers.js";

describe("remote detection", () => {
  let env: ReturnType<typeof createTestHome>;
  let repoDir: string;

  beforeEach(() => {
    env = createTestHome();
    repoDir = path.join(env.home, "test-repo");
    fs.mkdirSync(repoDir);
    execSync("git init", { cwd: repoDir, stdio: "pipe" });
  });
  afterEach(() => env.cleanup());

  describe("detectAllRemotes", () => {
    it("returns empty array when no remotes exist", async () => {
      const config = await import("../src/config.js");
      // Run in the test repo with no remotes
      const origCwd = process.cwd();
      process.chdir(repoDir);
      try {
        const remotes = config.detectAllRemotes();
        assert.deepEqual(remotes, []);
      } finally {
        process.chdir(origCwd);
      }
    });

    it("detects a single HTTPS remote", async () => {
      execSync(
        "git remote add origin https://github.com/alice/myrepo.git",
        { cwd: repoDir, stdio: "pipe" }
      );

      const config = await import("../src/config.js");
      const origCwd = process.cwd();
      process.chdir(repoDir);
      try {
        const remotes = config.detectAllRemotes();
        assert.equal(remotes.length, 1);
        assert.equal(remotes[0].remoteName, "origin");
        assert.equal(remotes[0].owner, "alice");
        assert.equal(remotes[0].repo, "myrepo");
      } finally {
        process.chdir(origCwd);
      }
    });

    it("detects a single SSH remote", async () => {
      execSync(
        "git remote add origin git@github.com:bob/project.git",
        { cwd: repoDir, stdio: "pipe" }
      );

      const config = await import("../src/config.js");
      const origCwd = process.cwd();
      process.chdir(repoDir);
      try {
        const remotes = config.detectAllRemotes();
        assert.equal(remotes.length, 1);
        assert.equal(remotes[0].owner, "bob");
        assert.equal(remotes[0].repo, "project");
      } finally {
        process.chdir(origCwd);
      }
    });

    it("detects multiple remotes", async () => {
      execSync(
        "git remote add origin https://github.com/alice/myrepo.git",
        { cwd: repoDir, stdio: "pipe" }
      );
      execSync(
        "git remote add upstream https://github.com/org/myrepo.git",
        { cwd: repoDir, stdio: "pipe" }
      );
      execSync(
        "git remote add fork git@github.com:bob/myrepo.git",
        { cwd: repoDir, stdio: "pipe" }
      );

      const config = await import("../src/config.js");
      const origCwd = process.cwd();
      process.chdir(repoDir);
      try {
        const remotes = config.detectAllRemotes();
        assert.equal(remotes.length, 3);

        const names = remotes.map((r) => r.remoteName);
        assert.ok(names.includes("origin"));
        assert.ok(names.includes("upstream"));
        assert.ok(names.includes("fork"));

        const origin = remotes.find((r) => r.remoteName === "origin")!;
        assert.equal(origin.owner, "alice");

        const upstream = remotes.find((r) => r.remoteName === "upstream")!;
        assert.equal(upstream.owner, "org");

        const fork = remotes.find((r) => r.remoteName === "fork")!;
        assert.equal(fork.owner, "bob");
      } finally {
        process.chdir(origCwd);
      }
    });

    it("deduplicates remotes pointing to the same repo", async () => {
      execSync(
        "git remote add origin https://github.com/alice/myrepo.git",
        { cwd: repoDir, stdio: "pipe" }
      );
      execSync(
        "git remote add other git@github.com:alice/myrepo.git",
        { cwd: repoDir, stdio: "pipe" }
      );

      const config = await import("../src/config.js");
      const origCwd = process.cwd();
      process.chdir(repoDir);
      try {
        const remotes = config.detectAllRemotes();
        assert.equal(remotes.length, 1);
        assert.equal(remotes[0].owner, "alice");
        assert.equal(remotes[0].repo, "myrepo");
      } finally {
        process.chdir(origCwd);
      }
    });

    it("skips non-GitHub remotes", async () => {
      execSync(
        "git remote add origin https://github.com/alice/myrepo.git",
        { cwd: repoDir, stdio: "pipe" }
      );
      execSync(
        "git remote add gitlab https://gitlab.com/alice/myrepo.git",
        { cwd: repoDir, stdio: "pipe" }
      );

      const config = await import("../src/config.js");
      const origCwd = process.cwd();
      process.chdir(repoDir);
      try {
        const remotes = config.detectAllRemotes();
        assert.equal(remotes.length, 1);
        assert.equal(remotes[0].remoteName, "origin");
      } finally {
        process.chdir(origCwd);
      }
    });

    it("strips .git suffix from repo name", async () => {
      execSync(
        "git remote add origin https://github.com/alice/my-repo.git",
        { cwd: repoDir, stdio: "pipe" }
      );

      const config = await import("../src/config.js");
      const origCwd = process.cwd();
      process.chdir(repoDir);
      try {
        const remotes = config.detectAllRemotes();
        assert.equal(remotes[0].repo, "my-repo");
      } finally {
        process.chdir(origCwd);
      }
    });
  });

  describe("detectRepoFromCwd", () => {
    it("prefers origin over other remotes", async () => {
      execSync(
        "git remote add upstream https://github.com/org/repo.git",
        { cwd: repoDir, stdio: "pipe" }
      );
      execSync(
        "git remote add origin https://github.com/alice/repo.git",
        { cwd: repoDir, stdio: "pipe" }
      );

      const config = await import("../src/config.js");
      const origCwd = process.cwd();
      process.chdir(repoDir);
      try {
        const result = config.detectRepoFromCwd();
        assert.ok(result);
        assert.equal(result.owner, "alice");
      } finally {
        process.chdir(origCwd);
      }
    });

    it("falls back to first remote when no origin", async () => {
      execSync(
        "git remote add upstream https://github.com/org/repo.git",
        { cwd: repoDir, stdio: "pipe" }
      );

      const config = await import("../src/config.js");
      const origCwd = process.cwd();
      process.chdir(repoDir);
      try {
        const result = config.detectRepoFromCwd();
        assert.ok(result);
        assert.equal(result.owner, "org");
      } finally {
        process.chdir(origCwd);
      }
    });

    it("returns null when no remotes", async () => {
      const config = await import("../src/config.js");
      const origCwd = process.cwd();
      process.chdir(repoDir);
      try {
        const result = config.detectRepoFromCwd();
        assert.equal(result, null);
      } finally {
        process.chdir(origCwd);
      }
    });
  });
});
