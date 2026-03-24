import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createTestHome, freshImport, nextImportId, writeJson } from "./helpers.js";

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
      botUsername: "bot",
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

    it("identifies approval responses via isControlComment", async () => {
      const batch = await freshImport<typeof import("../src/batch.js")>("../src/batch.js");

      assert.equal(batch.isControlComment("@bot allow once", "bot"), true);
      assert.equal(batch.isControlComment("@bot allow always `^docker\\b`", "bot"), true);
      assert.equal(batch.isControlComment("@bot deny", "bot"), true);
      assert.equal(batch.isControlComment("@bot undo", "bot"), true);
      assert.equal(batch.isControlComment("@bot try again", "bot"), true);
      assert.equal(batch.isControlComment("@bot retry", "bot"), true);
      assert.equal(batch.isControlComment("@bot fix the bug", "bot"), false);
      assert.equal(batch.isControlComment("@bot refactor this", "bot"), false);
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

  describe("isUndoCommand", () => {
    it("detects undo commands", async () => {
      const poller = await freshImport<typeof import("../src/poller.js")>("../src/poller.js");
      assert.equal(poller.isUndoCommand("@bot undo", "bot"), true);
      assert.equal(poller.isUndoCommand("@Bot Undo", "bot"), true);
      assert.equal(poller.isUndoCommand("@bot undo the last change", "bot"), true);
      assert.equal(poller.isUndoCommand("@bot fix this", "bot"), false);
      assert.equal(poller.isUndoCommand("undo", "bot"), false); // no @bot prefix
    });
  });

  describe("isTryAgainCommand", () => {
    it("detects try again and retry commands", async () => {
      const poller = await freshImport<typeof import("../src/poller.js")>("../src/poller.js");
      assert.equal(poller.isTryAgainCommand("@bot try again", "bot"), true);
      assert.equal(poller.isTryAgainCommand("@bot retry", "bot"), true);
      assert.equal(poller.isTryAgainCommand("@Bot Try Again", "bot"), true);
      assert.equal(poller.isTryAgainCommand("@Bot Retry", "bot"), true);
      assert.equal(poller.isTryAgainCommand("@bot try again: use a different approach", "bot"), true);
      assert.equal(poller.isTryAgainCommand("@bot fix this", "bot"), false);
      assert.equal(poller.isTryAgainCommand("try again", "bot"), false);
    });
  });

  describe("extractTryAgainNote", () => {
    it("extracts note text after try again", async () => {
      const poller = await freshImport<typeof import("../src/poller.js")>("../src/poller.js");
      assert.equal(poller.extractTryAgainNote("@bot try again: use a different approach"), "use a different approach");
      assert.equal(poller.extractTryAgainNote("@bot retry - focus on performance"), "focus on performance");
      assert.equal(poller.extractTryAgainNote("@bot retry use hooks instead"), "use hooks instead");
    });

    it("returns null when no note is present", async () => {
      const poller = await freshImport<typeof import("../src/poller.js")>("../src/poller.js");
      assert.equal(poller.extractTryAgainNote("@bot try again"), null);
      assert.equal(poller.extractTryAgainNote("@bot retry"), null);
    });
  });

  describe("rewriteLocalPaths", () => {
    it("rewrites markdown links with local workspace paths to GitHub URLs", async () => {
      const id = nextImportId();
      const config = await freshImport<typeof import("../src/config.js")>("../src/config.js", id);
      const poller = await freshImport<typeof import("../src/poller.js")>("../src/poller.js", id);

      const base = config.workspaceDir(repoId, "feature");
      const input = `See [the file](${base}/src/app.ts) for details.`;
      const result = poller.rewriteLocalPaths(input, repoId, "feature");
      assert.equal(result, "See [the file](https://github.com/test/repo/blob/feature/src/app.ts) for details.");
    });

    it("strips bare workspace paths", async () => {
      const id = nextImportId();
      const config = await freshImport<typeof import("../src/config.js")>("../src/config.js", id);
      const poller = await freshImport<typeof import("../src/poller.js")>("../src/poller.js", id);

      const base = config.workspaceDir(repoId, "main");
      const input = `Modified ${base}/README.md`;
      const result = poller.rewriteLocalPaths(input, repoId, "main");
      assert.equal(result, "Modified README.md");
    });

    it("handles text with no local paths", async () => {
      const poller = await freshImport<typeof import("../src/poller.js")>("../src/poller.js");
      const input = "No paths here, just text.";
      assert.equal(poller.rewriteLocalPaths(input, repoId, "main"), input);
    });

    it("rewrites multiple paths in the same text", async () => {
      const id = nextImportId();
      const config = await freshImport<typeof import("../src/config.js")>("../src/config.js", id);
      const poller = await freshImport<typeof import("../src/poller.js")>("../src/poller.js", id);

      const base = config.workspaceDir(repoId, "dev");
      const input = `Changed [a](${base}/a.ts) and [b](${base}/b.ts).`;
      const result = poller.rewriteLocalPaths(input, repoId, "dev");
      assert.ok(result.includes("https://github.com/test/repo/blob/dev/a.ts"));
      assert.ok(result.includes("https://github.com/test/repo/blob/dev/b.ts"));
      assert.ok(!result.includes(base));
    });
  });

  describe("findLastBotCommentId", () => {
    it("returns the most recent comment_posted ID for the given PR", async () => {
      const id = nextImportId();
      const history = await freshImport<typeof import("../src/history.js")>("../src/history.js", id);
      const poller = await freshImport<typeof import("../src/poller.js")>("../src/poller.js", id);

      history.appendHistory(repoId, "feature", { type: "comment_posted", pr: 1, comment_id: 100 });
      history.appendHistory(repoId, "feature", { type: "commit_pushed", pr: 1, sha: "abc" });
      history.appendHistory(repoId, "feature", { type: "comment_posted", pr: 1, comment_id: 200 });

      assert.equal(poller.findLastBotCommentId(repoId, "feature", 1), 200);
    });

    it("returns null when no comment_posted events exist", async () => {
      const id = nextImportId();
      const history = await freshImport<typeof import("../src/history.js")>("../src/history.js", id);
      const poller = await freshImport<typeof import("../src/poller.js")>("../src/poller.js", id);

      history.appendHistory(repoId, "feature", { type: "commit_pushed", pr: 1, sha: "abc" });
      assert.equal(poller.findLastBotCommentId(repoId, "feature", 1), null);
    });

    it("filters by PR number", async () => {
      const id = nextImportId();
      const history = await freshImport<typeof import("../src/history.js")>("../src/history.js", id);
      const poller = await freshImport<typeof import("../src/poller.js")>("../src/poller.js", id);

      history.appendHistory(repoId, "feature", { type: "comment_posted", pr: 1, comment_id: 100 });
      history.appendHistory(repoId, "feature", { type: "comment_posted", pr: 2, comment_id: 200 });

      assert.equal(poller.findLastBotCommentId(repoId, "feature", 1), 100);
      assert.equal(poller.findLastBotCommentId(repoId, "feature", 2), 200);
    });

    it("returns null for empty history", async () => {
      const poller = await freshImport<typeof import("../src/poller.js")>("../src/poller.js");
      assert.equal(poller.findLastBotCommentId(repoId, "nonexistent", 1), null);
    });
  });

  describe("findLastTaskRequest (from batch)", () => {
    it("returns the last non-control comment body", async () => {
      const id = nextImportId();
      const history = await freshImport<typeof import("../src/history.js")>("../src/history.js", id);
      const batch = await freshImport<typeof import("../src/batch.js")>("../src/batch.js", id);

      history.appendHistory(repoId, "feature", {
        type: "comment_detected", pr: 1, comment_id: 10, author: "alice",
        body: "@bot fix the login bug",
      });
      history.appendHistory(repoId, "feature", {
        type: "comment_detected", pr: 1, comment_id: 11, author: "alice",
        body: "@bot allow once",
      });

      const result = batch.findLastTaskRequest(repoId, "feature", 1, "bot");
      assert.equal(result, "@bot fix the login bug");
    });

    it("returns the most recent task request, not the first", async () => {
      const id = nextImportId();
      const history = await freshImport<typeof import("../src/history.js")>("../src/history.js", id);
      const batch = await freshImport<typeof import("../src/batch.js")>("../src/batch.js", id);

      history.appendHistory(repoId, "feature", {
        type: "comment_detected", pr: 1, comment_id: 10, author: "alice",
        body: "@bot fix the login bug",
      });
      history.appendHistory(repoId, "feature", {
        type: "comment_detected", pr: 1, comment_id: 11, author: "alice",
        body: "@bot actually refactor the auth module instead",
      });

      const result = batch.findLastTaskRequest(repoId, "feature", 1, "bot");
      assert.equal(result, "@bot actually refactor the auth module instead");
    });

    it("skips control comments (undo, retry, allow, deny)", async () => {
      const id = nextImportId();
      const history = await freshImport<typeof import("../src/history.js")>("../src/history.js", id);
      const batch = await freshImport<typeof import("../src/batch.js")>("../src/batch.js", id);

      history.appendHistory(repoId, "feature", {
        type: "comment_detected", pr: 1, comment_id: 10, author: "alice",
        body: "@bot fix the login bug",
      });
      history.appendHistory(repoId, "feature", {
        type: "comment_detected", pr: 1, comment_id: 11, author: "alice",
        body: "@bot undo",
      });
      history.appendHistory(repoId, "feature", {
        type: "comment_detected", pr: 1, comment_id: 12, author: "alice",
        body: "@bot try again: use a different approach",
      });

      const result = batch.findLastTaskRequest(repoId, "feature", 1, "bot");
      assert.equal(result, "@bot fix the login bug");
    });

    it("returns null when only control comments exist", async () => {
      const id = nextImportId();
      const history = await freshImport<typeof import("../src/history.js")>("../src/history.js", id);
      const batch = await freshImport<typeof import("../src/batch.js")>("../src/batch.js", id);

      history.appendHistory(repoId, "feature", {
        type: "comment_detected", pr: 1, comment_id: 10, author: "alice",
        body: "@bot undo",
      });

      assert.equal(batch.findLastTaskRequest(repoId, "feature", 1, "bot"), null);
    });

    it("returns null for empty history", async () => {
      const batch = await freshImport<typeof import("../src/batch.js")>("../src/batch.js");
      assert.equal(batch.findLastTaskRequest(repoId, "nonexistent", 1, "bot"), null);
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
    it("saves and loads seen comment IDs", async () => {
      const store = await freshImport<typeof import("../src/session-store.js")>(
        "../src/session-store.js"
      );
      const seen = new Set<number>([1, 2, 3]);
      store.saveSeenCommentIds(repoId, seen);
      const loaded = store.loadSeenCommentIds(repoId);
      assert.deepEqual([...loaded].sort(), [1, 2, 3]);
    });
  });
});
