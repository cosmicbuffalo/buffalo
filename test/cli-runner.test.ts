import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTestHome, writeJson } from "./helpers.js";

// These tests use the real module singletons (no cache busting) because
// cli-runner internally imports session-store/config/etc. We set HOME before
// importing so the default module instances pick up the temp dir.
// Since ESM top-level imports are cached, we use dynamic imports.

describe("cli-runner", () => {
  let env: ReturnType<typeof createTestHome>;
  const repoId = { owner: "test", repo: "repo" };

  // We need HOME set before importing, so set it in the describe scope
  // and import in each test. The first import wins for the module cache.

  beforeEach(() => {
    env = createTestHome();
    const repoPath = path.join(env.buffaloDir, "repos", "test", "repo");
    writeJson(path.join(env.buffaloDir, "whitelist.json"), {
      patterns: ["^ls\\b", "^cat\\b", "^git\\s+(status|diff)"],
    });
    writeJson(path.join(repoPath, "config.json"), {
      botTag: "@bot",
      authorizedUsers: ["alice"],
      backend: "claude",
      pollIntervalMs: 60000,
      githubToken: "ghp_test",
    });
    fs.mkdirSync(path.join(repoPath, "logs"), { recursive: true });
    fs.mkdirSync(path.join(repoPath, "history"), { recursive: true });
  });
  afterEach(() => env.cleanup());

  describe("monitorSession", () => {
    it("returns 'completed' when no session exists", async () => {
      // Use the main (un-busted) module — first import sets BUFFALO_DIR
      const runner = await import("../src/cli-runner.js");
      const result = await runner.monitorSession(repoId, "nonexistent");
      assert.equal(result, "completed");
    });

    it("returns 'paused' for paused sessions", async () => {
      const store = await import("../src/session-store.js");
      const runner = await import("../src/cli-runner.js");
      store.setSession(repoId, "feature-paused", {
        branch: "feature-paused", prNumber: 42, commentIds: [1],
        status: "paused", logOffset: 0,
      });
      const result = await runner.monitorSession(repoId, "feature-paused");
      assert.equal(result, "paused");
      store.removeSession(repoId, "feature-paused");
    });

    it("returns 'completed' when no log file exists", async () => {
      const store = await import("../src/session-store.js");
      const runner = await import("../src/cli-runner.js");
      store.setSession(repoId, "no-log", {
        branch: "no-log", prNumber: 42, commentIds: [1],
        status: "running", logOffset: 0,
      });
      const result = await runner.monitorSession(repoId, "no-log");
      assert.equal(result, "completed");
      store.removeSession(repoId, "no-log");
    });

    it("auto-approves whitelisted commands and logs history", async () => {
      const store = await import("../src/session-store.js");
      const runner = await import("../src/cli-runner.js");
      const config = await import("../src/config.js");
      const history = await import("../src/history.js");

      const branch = "auto-approve-test";
      store.setSession(repoId, branch, {
        branch, prNumber: 42, commentIds: [1],
        status: "running", logOffset: 0,
      });
      const logPath = config.logFile(repoId, branch);
      fs.writeFileSync(logPath, 'Do you want to run `ls -la`? (y/n)\n');

      await runner.monitorSession(repoId, branch);

      const events = history.readHistory(repoId, branch);
      const approvalEvent = events.find((e) => e.type === "command_requested");
      assert.ok(approvalEvent, "Should have logged command_requested");
      assert.equal(approvalEvent.approved, true);
      store.removeSession(repoId, branch);
    });

    it("updates log offset after monitoring", async () => {
      const store = await import("../src/session-store.js");
      const runner = await import("../src/cli-runner.js");
      const config = await import("../src/config.js");

      const branch = "offset-test";
      store.setSession(repoId, branch, {
        branch, prNumber: 42, commentIds: [1],
        status: "running", logOffset: 0,
      });
      const logPath = config.logFile(repoId, branch);
      fs.writeFileSync(logPath, "some output here\nmore output\n");

      await runner.monitorSession(repoId, branch);

      const session = store.getSession(repoId, branch);
      assert.ok(session);
      assert.ok(session.logOffset > 0, `Expected logOffset > 0, got ${session.logOffset}`);
      store.removeSession(repoId, branch);
    });
  });

  describe("handleApproval", () => {
    it("handles deny action", async () => {
      const store = await import("../src/session-store.js");
      const runner = await import("../src/cli-runner.js");
      const history = await import("../src/history.js");

      const branch = "deny-test";
      store.setSession(repoId, branch, {
        branch, prNumber: 42, commentIds: [1],
        status: "waiting_approval", logOffset: 0,
        pendingApproval: { command: "rm -rf /", failedPart: "rm -rf /" },
      });

      runner.handleApproval(repoId, branch, "deny");

      const session = store.getSession(repoId, branch);
      assert.equal(session?.status, "running");
      assert.equal(session?.pendingApproval, undefined);

      const events = history.readHistory(repoId, branch);
      assert.ok(events.some((e) => e.type === "command_denied"));
      store.removeSession(repoId, branch);
    });

    it("handles allow_once action", async () => {
      const store = await import("../src/session-store.js");
      const runner = await import("../src/cli-runner.js");
      const history = await import("../src/history.js");

      const branch = "allow-once-test";
      store.setSession(repoId, branch, {
        branch, prNumber: 42, commentIds: [1],
        status: "waiting_approval", logOffset: 0,
        pendingApproval: { command: "docker build .", failedPart: "docker build ." },
      });

      runner.handleApproval(repoId, branch, "allow_once");

      const session = store.getSession(repoId, branch);
      assert.equal(session?.status, "running");

      const events = history.readHistory(repoId, branch);
      assert.ok(events.some((e) => e.type === "command_approved" && e.action === "allow_once"));
      store.removeSession(repoId, branch);
    });

    it("does nothing when no pending approval", async () => {
      const store = await import("../src/session-store.js");
      const runner = await import("../src/cli-runner.js");

      const branch = "no-pending";
      store.setSession(repoId, branch, {
        branch, prNumber: 42, commentIds: [1],
        status: "running", logOffset: 0,
      });
      runner.handleApproval(repoId, branch, "deny");
      assert.equal(store.getSession(repoId, branch)?.status, "running");
      store.removeSession(repoId, branch);
    });

    it("does nothing for non-existent session", async () => {
      const runner = await import("../src/cli-runner.js");
      runner.handleApproval(repoId, "nonexistent", "deny");
    });
  });
});
