import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { batchComments, buildPrompt } from "../src/batch.js";
import type { PRComment } from "../src/github.js";

function makeComment(overrides: Partial<PRComment> = {}): PRComment {
  return {
    id: 1,
    body: "@bot fix the bug",
    user: "testuser",
    prNumber: 10,
    createdAt: "2026-01-01T00:00:00Z",
    htmlUrl: "https://github.com/owner/repo/pull/10#issuecomment-1",
    commentType: "issue",
    ...overrides,
  };
}

describe("batch", () => {
  describe("batchComments", () => {
    it("groups comments by PR number", () => {
      const comments = [
        makeComment({ id: 1, prNumber: 10 }),
        makeComment({ id: 2, prNumber: 20 }),
        makeComment({ id: 3, prNumber: 10 }),
      ];
      const branchMap = new Map([
        [10, "feature-a"],
        [20, "feature-b"],
      ]);

      const batches = batchComments(comments, branchMap);
      assert.equal(batches.length, 2);

      const batch10 = batches.find((b) => b.prNumber === 10)!;
      assert.equal(batch10.branch, "feature-a");
      assert.equal(batch10.comments.length, 2);

      const batch20 = batches.find((b) => b.prNumber === 20)!;
      assert.equal(batch20.branch, "feature-b");
      assert.equal(batch20.comments.length, 1);
    });

    it("skips comments with no branch mapping", () => {
      const comments = [
        makeComment({ id: 1, prNumber: 10 }),
        makeComment({ id: 2, prNumber: 99 }), // No mapping
      ];
      const branchMap = new Map([[10, "feature-a"]]);

      const batches = batchComments(comments, branchMap);
      assert.equal(batches.length, 1);
      assert.equal(batches[0].prNumber, 10);
    });

    it("returns empty array for no comments", () => {
      const batches = batchComments([], new Map());
      assert.equal(batches.length, 0);
    });

    it("handles single comment", () => {
      const comments = [makeComment({ id: 1, prNumber: 5 })];
      const branchMap = new Map([[5, "main"]]);

      const batches = batchComments(comments, branchMap);
      assert.equal(batches.length, 1);
      assert.equal(batches[0].comments.length, 1);
    });
  });

  describe("buildPrompt", () => {
    it("includes PR number and branch", () => {
      const batch = {
        prNumber: 42,
        branch: "fix-typo",
        comments: [makeComment({ body: "@bot fix the typo" })],
      };

      const prompt = buildPrompt(batch, "@bot");
      assert.ok(prompt.includes("PR #42"));
      assert.ok(prompt.includes('"fix-typo"'));
    });

    it("strips the bot tag from comment bodies", () => {
      const batch = {
        prNumber: 10,
        branch: "feature",
        comments: [makeComment({ body: "@bot please fix this", user: "alice" })],
      };

      const prompt = buildPrompt(batch, "@bot");
      assert.ok(prompt.includes("@alice: please fix this"));
      assert.ok(!prompt.includes("@bot"));
    });

    it("combines multiple comments into one prompt", () => {
      const batch = {
        prNumber: 10,
        branch: "feature",
        comments: [
          makeComment({ body: "@bot fix bug A", user: "alice" }),
          makeComment({ body: "@bot fix bug B", user: "bob" }),
        ],
      };

      const prompt = buildPrompt(batch, "@bot");
      assert.ok(prompt.includes("@alice: fix bug A"));
      assert.ok(prompt.includes("@bob: fix bug B"));
    });

    it("includes action instruction", () => {
      const batch = {
        prNumber: 10,
        branch: "feature",
        comments: [makeComment()],
      };

      const prompt = buildPrompt(batch, "@bot");
      assert.ok(prompt.includes("Please address all the above requests"));
    });
  });
});
