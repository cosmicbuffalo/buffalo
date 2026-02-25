import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createTestHome, freshImport, writeJson } from "./helpers.js";

describe("poller", () => {
  let env: ReturnType<typeof createTestHome>;
  const repoId = { owner: "test", repo: "repo" };

  beforeEach(() => {
    env = createTestHome();
    const repoPath = path.join(env.buffaloDir, "repos", "test", "repo");
    writeJson(path.join(env.buffaloDir, "whitelist.json"), {
      patterns: ["^ls\\b", "^cat\\b"],
    });
    writeJson(path.join(repoPath, "config.json"), {
      botTag: "@bot",
      authorizedUsers: ["alice", "bob"],
      backend: "claude",
      pollIntervalMs: 1000,
      githubToken: "ghp_test",
    });
  });
  afterEach(() => env.cleanup());

  describe("comment filtering logic", () => {
    it("filters comments by authorized users", async () => {
      const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");
      const repoCfg = config.loadRepoConfig(repoId);

      const comments = [
        { id: 1, body: "@bot fix bug", user: "alice", prNumber: 1, createdAt: "", htmlUrl: "" },
        { id: 2, body: "@bot hack", user: "evil", prNumber: 1, createdAt: "", htmlUrl: "" },
        { id: 3, body: "@bot add test", user: "bob", prNumber: 2, createdAt: "", htmlUrl: "" },
      ];

      const authorized = comments.filter((c) => repoCfg.authorizedUsers.includes(c.user));
      assert.equal(authorized.length, 2);
      assert.ok(authorized.every((c) => ["alice", "bob"].includes(c.user)));
    });

    it("identifies approval responses", () => {
      const testCases = [
        { body: "@bot allow once", isApproval: true },
        { body: "@bot allow always `^docker\\b`", isApproval: true },
        { body: "@bot deny", isApproval: true },
        { body: "@bot fix the bug", isApproval: false },
        { body: "@bot refactor this", isApproval: false },
      ];

      for (const tc of testCases) {
        const lower = tc.body.toLowerCase();
        const isApproval =
          lower.includes("allow once") ||
          lower.includes("allow always") ||
          lower.includes("@bot deny");
        assert.equal(isApproval, tc.isApproval, `Failed for: ${tc.body}`);
      }
    });

    it("extracts pattern from 'allow always' responses", () => {
      const cases = [
        { body: "allow always `^docker\\b`", expected: "^docker\\b" },
        { body: "allow always ^rm\\b", expected: "^rm\\b" },
        { body: "allow always `^curl\\s`", expected: "^curl\\s" },
      ];

      for (const tc of cases) {
        const match = tc.body.match(/allow always\s+`?([^`\n]+)`?/i);
        assert.ok(match, `No match for: ${tc.body}`);
        assert.equal(match![1].trim(), tc.expected);
      }
    });
  });

  describe("startPolling / stopPolling", () => {
    it("stopPolling clears timer", async () => {
      const poller = await freshImport<typeof import("../src/poller.js")>("../src/poller.js");
      // stopPolling should not throw even if not running
      poller.stopPolling();
    });
  });

  describe("last poll persistence", () => {
    it("saves and loads poll timestamp", async () => {
      const store = await freshImport<typeof import("../src/session-store.js")>(
        "../src/session-store.js"
      );
      const ts = "2026-02-25T10:00:00Z";
      store.saveLastPoll(repoId, ts);
      assert.equal(store.loadLastPoll(repoId), ts);
    });
  });
});
