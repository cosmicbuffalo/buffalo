import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  batchComments,
  buildPrompt,
  buildClarificationFollowUp,
  extractCommitMessage,
  extractClarification,
  extractPerCommentResponses,
  stripDirectives,
} from "../src/batch.js";
import type { PRComment } from "../src/github.js";
import type { SessionInfo } from "../src/session-store.js";

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

    it("includes diff hunk and RESPONSE[id] footer for review comments", () => {
      const batch = {
        prNumber: 10,
        branch: "feature",
        comments: [
          makeComment({
            id: 42,
            commentType: "review",
            path: "src/foo.ts",
            line: 7,
            diffHunk: "@@ -1,3 +1,4 @@\n+import bar",
            body: "@bot rename this variable",
          }),
        ],
      };

      const prompt = buildPrompt(batch, "@bot");
      assert.ok(prompt.includes("Comment #42"));
      assert.ok(prompt.includes("src/foo.ts"));
      assert.ok(prompt.includes("line 7"));
      assert.ok(prompt.includes("import bar"));
      assert.ok(prompt.includes("RESPONSE[42]:"));
    });

    it("uses summary footer (no RESPONSE[id]) for issue comments", () => {
      const batch = {
        prNumber: 10,
        branch: "feature",
        comments: [makeComment({ commentType: "issue" })],
      };
      const prompt = buildPrompt(batch, "@bot");
      assert.ok(prompt.includes("brief summary"));
      assert.ok(!prompt.includes("RESPONSE["));
    });
  });

  describe("extractCommitMessage", () => {
    it("extracts a plain COMMIT: line", () => {
      const response = "Did the thing.\nCOMMIT: fix: correct the API timeout\nDone.";
      assert.equal(extractCommitMessage(response), "fix: correct the API timeout");
    });

    it("extracts COMMIT: with a numbered list prefix", () => {
      const response = "1. Summary of changes\n2. COMMIT: feat: add retry logic";
      assert.equal(extractCommitMessage(response), "feat: add retry logic");
    });

    it("returns null when no COMMIT line present", () => {
      assert.equal(extractCommitMessage("Just some text with no directive."), null);
    });

    it("returns null for null input", () => {
      assert.equal(extractCommitMessage(null), null);
    });
  });

  describe("extractClarification", () => {
    it("extracts a CLARIFICATION_NEEDED line", () => {
      const response = "CLARIFICATION_NEEDED: Should the function be async or sync?";
      assert.equal(
        extractClarification(response),
        "Should the function be async or sync?"
      );
    });

    it("extracts CLARIFICATION_NEEDED with a numbered list prefix", () => {
      const response = "1. CLARIFICATION_NEEDED: Which endpoint should be used?";
      assert.equal(extractClarification(response), "Which endpoint should be used?");
    });

    it("returns null when no CLARIFICATION_NEEDED line present", () => {
      assert.equal(extractClarification("COMMIT: fix something"), null);
    });

    it("returns null for null input", () => {
      assert.equal(extractClarification(null), null);
    });
  });

  describe("stripDirectives", () => {
    it("removes COMMIT: lines", () => {
      const input = "Made the change.\nCOMMIT: fix: do the thing\n";
      const result = stripDirectives(input);
      assert.ok(!result?.includes("COMMIT:"));
      assert.ok(result?.includes("Made the change."));
    });

    it("removes CLARIFICATION_NEEDED: lines", () => {
      const input = "Some text.\nCLARIFICATION_NEEDED: Which one?\n";
      assert.ok(!stripDirectives(input)?.includes("CLARIFICATION_NEEDED:"));
    });

    it("removes RESPONSE[id]: lines", () => {
      const input = "1. Summary\nRESPONSE[42]: looks good\n2. COMMIT: fix it";
      const result = stripDirectives(input);
      assert.ok(!result?.includes("RESPONSE[42]"));
      assert.ok(!result?.includes("COMMIT:"));
    });

    it("strips the 1. prefix when only one bullet remains after filtering", () => {
      const input = "1. Made the fix.\n2. COMMIT: fix: the thing\n";
      const result = stripDirectives(input);
      assert.ok(!result?.startsWith("1."));
      assert.ok(result?.includes("Made the fix."));
    });

    it("preserves multiple bullets when more than one remains", () => {
      const input = "1. Changed foo.\n2. Updated bar.\n3. COMMIT: refactor: cleanup";
      const result = stripDirectives(input);
      assert.ok(result?.includes("1."));
      assert.ok(result?.includes("2."));
    });

    it("returns null for null input", () => {
      assert.equal(stripDirectives(null), null);
    });

    it("returns null when only directives remain", () => {
      assert.equal(stripDirectives("COMMIT: fix: only directive"), null);
    });
  });

  describe("extractPerCommentResponses", () => {
    it("extracts RESPONSE[id] entries into a map", () => {
      const response = "RESPONSE[1]: fixed the null check\nRESPONSE[2]: renamed the variable";
      const map = extractPerCommentResponses(response);
      assert.ok(map !== null);
      assert.equal(map!.get(1), "fixed the null check");
      assert.equal(map!.get(2), "renamed the variable");
    });

    it("handles numbered list prefix on RESPONSE lines", () => {
      const response = "1. RESPONSE[42]: addressed the comment\n2. COMMIT: fix it";
      const map = extractPerCommentResponses(response);
      assert.ok(map !== null);
      assert.equal(map!.get(42), "addressed the comment");
    });

    it("returns null when no RESPONSE lines are present", () => {
      assert.equal(extractPerCommentResponses("Just a summary.\nCOMMIT: fix"), null);
    });

    it("returns null for null input", () => {
      assert.equal(extractPerCommentResponses(null), null);
    });
  });

  describe("buildClarificationFollowUp", () => {
    it("includes the original task context and the clarification answer", () => {
      const session: SessionInfo = {
        branch: "feature",
        prNumber: 10,
        commentIds: [1],
        status: "waiting_clarification",
        logOffset: 0,
        triggerComments: [
          { user: "alice", body: "@bot refactor the handler", commentType: "issue" },
        ],
        pendingClarification: {
          question: "Should the function be async or sync?",
          commentId: 999,
        },
      };
      const batch = {
        prNumber: 10,
        branch: "feature",
        comments: [
          makeComment({ body: "@bot make it async", user: "alice" }),
        ],
      };

      const prompt = buildClarificationFollowUp(session, batch, "@bot");
      assert.ok(prompt.includes("PR #10"));
      assert.ok(prompt.includes("refactor the handler"));
      assert.ok(prompt.includes("Should the function be async or sync?"));
      assert.ok(prompt.includes("make it async"));
    });
  });
});
