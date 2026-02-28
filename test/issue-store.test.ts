import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHome, freshImport } from "./helpers.js";

describe("issue-store", () => {
  let env: ReturnType<typeof createTestHome>;
  const repoId = { owner: "test", repo: "repo" };

  beforeEach(async () => {
    env = createTestHome();
    const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");
    config.ensureDir(config.repoDir(repoId));
  });
  afterEach(() => env.cleanup());

  describe("seen issue IDs", () => {
    it("returns empty set when no file exists", async () => {
      const store = await freshImport<typeof import("../src/issue-store.js")>(
        "../src/issue-store.js"
      );
      const ids = store.loadSeenIssueIds(repoId);
      assert.equal(ids.size, 0);
    });

    it("saves and loads seen issue IDs", async () => {
      const store = await freshImport<typeof import("../src/issue-store.js")>(
        "../src/issue-store.js"
      );
      const seen = new Set<number>([1, 2, 3]);
      store.saveSeenIssueIds(repoId, seen);
      const loaded = store.loadSeenIssueIds(repoId);
      assert.deepEqual([...loaded].sort((a, b) => a - b), [1, 2, 3]);
    });

    it("round-trips an empty set", async () => {
      const store = await freshImport<typeof import("../src/issue-store.js")>(
        "../src/issue-store.js"
      );
      store.saveSeenIssueIds(repoId, new Set<number>());
      assert.equal(store.loadSeenIssueIds(repoId).size, 0);
    });
  });

  describe("seen issue comment IDs", () => {
    it("returns empty set when no file exists", async () => {
      const store = await freshImport<typeof import("../src/issue-store.js")>(
        "../src/issue-store.js"
      );
      assert.equal(store.loadSeenIssueCommentIds(repoId).size, 0);
    });

    it("saves and loads seen issue comment IDs", async () => {
      const store = await freshImport<typeof import("../src/issue-store.js")>(
        "../src/issue-store.js"
      );
      const seen = new Set<number>([100, 200, 300]);
      store.saveSeenIssueCommentIds(repoId, seen);
      const loaded = store.loadSeenIssueCommentIds(repoId);
      assert.deepEqual([...loaded].sort((a, b) => a - b), [100, 200, 300]);
    });

    it("seen issue IDs and comment IDs are stored independently", async () => {
      const store = await freshImport<typeof import("../src/issue-store.js")>(
        "../src/issue-store.js"
      );
      store.saveSeenIssueIds(repoId, new Set<number>([1, 2]));
      store.saveSeenIssueCommentIds(repoId, new Set<number>([10, 20]));
      assert.deepEqual([...store.loadSeenIssueIds(repoId)].sort((a, b) => a - b), [1, 2]);
      assert.deepEqual([...store.loadSeenIssueCommentIds(repoId)].sort((a, b) => a - b), [10, 20]);
    });
  });

  describe("issue-to-PR mapping", () => {
    it("returns undefined for unknown issue", async () => {
      const store = await freshImport<typeof import("../src/issue-store.js")>(
        "../src/issue-store.js"
      );
      assert.equal(store.getIssuePr(repoId, 42), undefined);
    });

    it("stores and retrieves issue-PR mapping", async () => {
      const store = await freshImport<typeof import("../src/issue-store.js")>(
        "../src/issue-store.js"
      );
      store.setIssuePr(repoId, 42, 15, "fix/login-bug");
      const entry = store.getIssuePr(repoId, 42);
      assert.ok(entry !== undefined);
      assert.equal(entry!.prNumber, 15);
      assert.equal(entry!.branch, "fix/login-bug");
    });

    it("stores multiple issue-PR mappings independently", async () => {
      const store = await freshImport<typeof import("../src/issue-store.js")>(
        "../src/issue-store.js"
      );
      store.setIssuePr(repoId, 1, 10, "fix/issue-1");
      store.setIssuePr(repoId, 2, 20, "fix/issue-2");
      assert.equal(store.getIssuePr(repoId, 1)?.prNumber, 10);
      assert.equal(store.getIssuePr(repoId, 2)?.prNumber, 20);
      assert.equal(store.getIssuePr(repoId, 3), undefined);
    });

    it("overwrites existing mapping on setIssuePr", async () => {
      const store = await freshImport<typeof import("../src/issue-store.js")>(
        "../src/issue-store.js"
      );
      store.setIssuePr(repoId, 42, 15, "fix/old-branch");
      store.setIssuePr(repoId, 42, 16, "fix/new-branch");
      const entry = store.getIssuePr(repoId, 42);
      assert.equal(entry!.prNumber, 16);
      assert.equal(entry!.branch, "fix/new-branch");
    });

    it("loadIssuePrMap returns empty object when no file exists", async () => {
      const store = await freshImport<typeof import("../src/issue-store.js")>(
        "../src/issue-store.js"
      );
      const map = store.loadIssuePrMap(repoId);
      assert.deepEqual(map, {});
    });

    it("saveIssuePrMap and loadIssuePrMap round-trip", async () => {
      const store = await freshImport<typeof import("../src/issue-store.js")>(
        "../src/issue-store.js"
      );
      const map = { "5": { prNumber: 99, branch: "feat/my-feature" } };
      store.saveIssuePrMap(repoId, map);
      assert.deepEqual(store.loadIssuePrMap(repoId), map);
    });
  });
});
