import type { PRComment } from "./github.js";
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

const FOOTER = [
  "",
  "Please address all the above requests. Make the necessary code changes.",
  "Do NOT run `git add`, `git commit`, or `git push` — the bot will commit and push for you.",
  "When finished, provide:",
  "1. A brief summary of what you changed and why.",
  "2. A suggested commit message on its own line starting with exactly `COMMIT: ` — e.g. `COMMIT: fix: correct the API timeout handling`",
  "If you need clarification before you can proceed, output a single line starting with exactly `CLARIFICATION_NEEDED: ` followed by your question — e.g. `CLARIFICATION_NEEDED: Should the new function be async or sync?` — and do NOT include a COMMIT line. The bot will post your question to the PR and relay the human's answer back to you.",
];

/**
 * Build a combined prompt from a batch of comments.
 */
export function buildPrompt(batch: CommentBatch, botTag: string): string {
  const lines: string[] = [
    `You are working on PR #${batch.prNumber} on branch "${batch.branch}".`,
    `The following requests were made:`,
    "",
  ];

  for (const c of batch.comments) {
    const body = c.body.replace(botTag, "").trim();
    lines.push(`- @${c.user}: ${body}`);
  }

  lines.push(...FOOTER);
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

  for (const c of session.triggerComments ?? []) {
    const body = c.body.replace(new RegExp(botTag, "gi"), "").trim();
    lines.push(`- @${c.user}: ${body}`);
  }

  lines.push(
    "",
    `You asked for clarification: "${session.pendingClarification!.question}"`,
    "",
    "Here is the human's response:",
    "",
    answer,
  );

  lines.push(...FOOTER);
  return lines.join("\n");
}

/**
 * Extract the suggested commit message from the agent's response.
 * Looks for a line starting with "COMMIT: " (case-insensitive).
 */
export function extractCommitMessage(response: string | null): string | null {
  if (!response) return null;
  const match = response.match(/^COMMIT:\s*(.+)$/im);
  return match?.[1]?.trim() ?? null;
}

/**
 * Extract a clarification question from the agent's response.
 * Looks for a line starting with "CLARIFICATION_NEEDED: " (case-insensitive).
 */
export function extractClarification(response: string | null): string | null {
  if (!response) return null;
  const match = response.match(/^CLARIFICATION_NEEDED:\s*(.+)$/im);
  return match?.[1]?.trim() ?? null;
}
