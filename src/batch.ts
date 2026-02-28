import type { PRComment, Issue, IssueComment } from "./github.js";
import type { SessionInfo } from "./session-store.js";

export interface CommentBatch {
  prNumber: number;
  branch: string;
  comments: PRComment[];
}

/**
 * Group comments by PR number (and therefore branch).
 */
export function batchComments(
  comments: PRComment[],
  branchMap: Map<number, string>
): CommentBatch[] {
  const groups = new Map<number, PRComment[]>();

  for (const c of comments) {
    const list = groups.get(c.prNumber) ?? [];
    list.push(c);
    groups.set(c.prNumber, list);
  }

  const batches: CommentBatch[] = [];
  for (const [prNumber, prComments] of groups) {
    const branch = branchMap.get(prNumber);
    if (!branch) continue;
    batches.push({ prNumber, branch, comments: prComments });
  }

  return batches;
}

const CLARIFICATION_INSTRUCTION =
  "If you need clarification before you can proceed, output a single line starting with exactly " +
  "`CLARIFICATION_NEEDED: ` followed by your question — e.g. `CLARIFICATION_NEEDED: Should the new function be async or sync?` " +
  "— and do NOT include a COMMIT line. If you do NOT need clarification, omit the line entirely (never output `CLARIFICATION_NEEDED: none`). The bot will post your question to the PR and relay the human's answer back to you.";

function buildFooter(reviewComments: PRComment[]): string[] {
  const lines: string[] = [
    "",
    "Please address all the above requests. Make the necessary code changes.",
    "Do NOT run `git add`, `git commit`, or `git push` — the bot will commit and push for you.",
    "When finished, provide:",
  ];

  if (reviewComments.length > 0) {
    lines.push(
      "- A single-line response for each inline comment using this exact format:",
    );
    for (const c of reviewComments) {
      lines.push(`  RESPONSE[${c.id}]: <your one-line response to comment #${c.id}>`);
    }
  } else {
    lines.push("- A brief summary of what you changed and why.");
  }

  lines.push(
    "- A suggested commit message on a line starting with exactly `COMMIT: ` — e.g. `COMMIT: fix: correct the API timeout handling`",
    CLARIFICATION_INSTRUCTION,
  );

  return lines;
}

/**
 * Build a combined prompt from a batch of comments.
 */
export function buildPrompt(batch: CommentBatch, botTag: string): string {
  const lines: string[] = [
    `You are working on PR #${batch.prNumber} on branch "${batch.branch}".`,
    `The following requests were made:`,
    "",
  ];

  const reviewComments: PRComment[] = [];

  for (const c of batch.comments) {
    const body = c.body.replace(botTag, "").trim();
    if (c.commentType === "review" && c.path) {
      reviewComments.push(c);
      const loc = c.line != null ? ` line ${c.line}` : "";
      lines.push(`- Comment #${c.id} by @${c.user} (on \`${c.path}\`${loc}): ${body}`);
      if (c.diffHunk) {
        lines.push(`  Code context:`);
        lines.push("  ```diff");
        for (const l of c.diffHunk.split("\n")) lines.push(`  ${l}`);
        lines.push("  ```");
      }
    } else {
      lines.push(`- @${c.user}: ${body}`);
    }
  }

  lines.push(...buildFooter(reviewComments));
  return lines.join("\n");
}

/**
 * Build a follow-up prompt that delivers a clarification answer back to the agent.
 */
export function buildClarificationFollowUp(
  session: SessionInfo,
  batch: CommentBatch,
  botTag: string
): string {
  const answer = batch.comments
    .map((c) => c.body.replace(new RegExp(botTag, "gi"), "").trim())
    .join("\n");

  const lines: string[] = [
    `You are working on PR #${batch.prNumber} on branch "${batch.branch}".`,
    "",
    "You were originally asked to:",
    "",
  ];

  const reviewComments: PRComment[] = [];

  for (const c of session.triggerComments ?? []) {
    const body = c.body.replace(new RegExp(botTag, "gi"), "").trim();
    if (c.commentType === "review" && c.commentId) {
      // Reconstruct a minimal PRComment-like entry for the footer
      reviewComments.push({ id: c.commentId, commentType: "review" } as PRComment);
      lines.push(`- Comment #${c.commentId} by @${c.user}: ${body}`);
    } else {
      lines.push(`- @${c.user}: ${body}`);
    }
  }

  lines.push(
    "",
    `You asked for clarification: "${session.pendingClarification!.question}"`,
    "",
    "Here is the human's response:",
    "",
    answer,
  );

  lines.push(...buildFooter(reviewComments));
  return lines.join("\n");
}

// Matches an optional leading numbered-list prefix like "1. " or "2. "
const LIST_PREFIX = /^(?:\d+\.\s*)?/;

/**
 * Strip bot-directive lines and RESPONSE[id] blocks from a response before
 * posting to GitHub — they're internal signals, not human-readable output.
 * If removing directives leaves only a single numbered bullet, its prefix is
 * also stripped (a one-item list isn't a list).
 */
export function stripDirectives(response: string | null): string | null {
  if (!response) return null;
  const bulletPat = /^\d+\.\s+/;

  // RESPONSE[id]: blocks are single-line directives (we instruct the agent to keep them one line).
  // COMMIT:, CLARIFICATION_NEEDED:, BRANCH_NAME:, PR_TITLE: are also single-line. Strip all of them.
  const directivePat = new RegExp(
    `${LIST_PREFIX.source}(?:COMMIT|CLARIFICATION_NEEDED|BRANCH_NAME|PR_TITLE|RESPONSE\\[\\d+\\]):\\s*`,
    "i"
  );

  const filtered = response.split("\n").filter((line) => !directivePat.test(line));

  const bulletCount = filtered.filter((l) => bulletPat.test(l)).length;
  const lines = bulletCount === 1
    ? filtered.map((l) => l.replace(bulletPat, ""))
    : filtered;

  return lines.join("\n").trim() || null;
}

/**
 * Extract per-comment responses from a structured agent response.
 * Looks for lines like "RESPONSE[42]: text" (with optional list prefix).
 * Returns a map of comment ID → response text, or null if none found.
 */
export function extractPerCommentResponses(response: string | null): Map<number, string> | null {
  if (!response) return null;
  const result = new Map<number, string>();
  const pattern = new RegExp(`${LIST_PREFIX.source}RESPONSE\\[(\\d+)\\]:\\s*(.+)$`, "gim");
  let match;
  while ((match = pattern.exec(response)) !== null) {
    const id = parseInt(match[1], 10);
    const text = match[2].trim();
    if (!isNaN(id) && text) result.set(id, text);
  }
  return result.size > 0 ? result : null;
}

/**
 * Extract the suggested commit message from the agent's response.
 * Handles lines like "COMMIT: ..." or "2. COMMIT: ..." (numbered list format).
 */
export function extractCommitMessage(response: string | null): string | null {
  if (!response) return null;
  const match = response.match(new RegExp(`${LIST_PREFIX.source}COMMIT:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? null;
}

/**
 * Extract a clarification question from the agent's response.
 * Handles lines like "CLARIFICATION_NEEDED: ..." or "2. CLARIFICATION_NEEDED: ...".
 */
export function extractClarification(response: string | null): string | null {
  if (!response) return null;
  const match = response.match(new RegExp(`${LIST_PREFIX.source}CLARIFICATION_NEEDED:\\s*(.+)$`, "im"));
  const raw = match?.[1]?.trim();
  if (!raw) return null;

  const cleaned = raw.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!cleaned) return null;

  const normalized = cleaned
    .toLowerCase()
    .replace(/[.!]+$/g, "")
    .trim();
  const placeholders = new Set([
    "none",
    "n/a",
    "na",
    "no",
    "null",
    "nil",
    "none needed",
    "not needed",
    "no clarification",
    "no clarification needed",
    "no question",
    "no questions",
  ]);
  if (placeholders.has(normalized)) return null;

  return cleaned;
}

/**
 * Extract a branch name from the agent's response.
 * Handles lines like "BRANCH_NAME: fix/login-bug" or "2. BRANCH_NAME: ...".
 */
export function extractBranchName(response: string | null): string | null {
  if (!response) return null;
  const match = response.match(new RegExp(`${LIST_PREFIX.source}BRANCH_NAME:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? null;
}

/**
 * Extract a PR title from the agent's response.
 * Handles lines like "PR_TITLE: Fix login session expiry" or "2. PR_TITLE: ...".
 */
export function extractPRTitle(response: string | null): string | null {
  if (!response) return null;
  const match = response.match(new RegExp(`${LIST_PREFIX.source}PR_TITLE:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? null;
}

/**
 * Build a prompt for a fresh issue session.
 */
export function buildIssuePrompt(issue: Issue, botTag: string): string {
  // Extract owner/repo from the issue URL: https://github.com/owner/repo/issues/42
  const urlMatch = issue.htmlUrl.match(/github\.com\/([^/]+\/[^/]+)\//);
  const repoSlug = urlMatch ? urlMatch[1] : "the repository";

  const lines: string[] = [
    `You are working on issue #${issue.number} "${issue.title}" in repo ${repoSlug}.`,
    "",
    "Issue body:",
    "---",
    issue.body,
    "---",
    "",
    "Analyze the issue. Either make code changes to resolve it, or respond with a comment.",
    `Do NOT run \`git add\`, \`git commit\`, \`git push\`, or open PRs yourself — the bot will handle that.`,
    "Do NOT push to or modify the default branch.",
    "",
    "When finished, provide:",
    "- If you made code changes:",
    "  BRANCH_NAME: <short kebab-case branch, e.g. fix/login-session-expiry>",
    "  PR_TITLE: <concise PR title>",
    "  COMMIT: <commit message>",
    "  A description of what you changed (used as PR body).",
    "- If answering without code changes: just provide your response.",
    "Only if you need clarification before proceeding: CLARIFICATION_NEEDED: <question>",
    "If no clarification is needed, omit that line entirely (never output `CLARIFICATION_NEEDED: none`).",
  ];

  return lines.join("\n");
}

/**
 * Build a follow-up prompt for an issue session after a new comment arrives.
 */
export function buildIssueFollowUpPrompt(
  session: SessionInfo,
  newComments: IssueComment[],
  botTag: string,
  existingPr?: { prNumber: number; branch: string }
): string {
  const issueNumber = session.issueNumber ?? session.prNumber;
  const title = session.issueTitle ? ` "${session.issueTitle}"` : "";

  const lines: string[] = [
    `You are working on issue #${issueNumber}${title}.`,
  ];

  if (existingPr) {
    lines.push(
      `This issue has an associated PR #${existingPr.prNumber} on branch "${existingPr.branch}".`
    );
  }

  lines.push("", "A follow-up comment was posted:", "");

  for (const c of newComments) {
    const body = c.body.replace(new RegExp(botTag, "gi"), "").trim();
    lines.push(`- @${c.user}: ${body}`);
  }

  if (session.triggerComments && session.triggerComments.length > 0) {
    lines.push("", "Original issue context:", "");
    for (const c of session.triggerComments) {
      const body = c.body.replace(new RegExp(botTag, "gi"), "").trim();
      lines.push(`- @${c.user}: ${body}`);
    }
  }

  lines.push(
    "",
    existingPr
      ? `Make any necessary code changes to the existing branch "${existingPr.branch}".`
      : "Make any necessary code changes.",
    `Do NOT run \`git add\`, \`git commit\`, \`git push\`, or open PRs yourself — the bot will handle that.`,
    "When finished, provide:",
    "- COMMIT: <commit message> (omit this line if no code changes were made)",
    ...(existingPr
      ? []
      : [
          "- If you made code changes that should become a PR:",
          "  BRANCH_NAME: <short kebab-case branch, e.g. fix/login-session-expiry>",
          "  PR_TITLE: <concise PR title>",
        ]),
    "- A response to post as a comment on the issue.",
    "Only if you need clarification before proceeding: CLARIFICATION_NEEDED: <question>",
    "If no clarification is needed, omit that line entirely (never output `CLARIFICATION_NEEDED: none`).",
  );

  return lines.join("\n");
}
