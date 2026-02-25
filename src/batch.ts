import type { PRComment } from "./github.js";

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

  lines.push(
    "",
    "Please address all the above requests. Make the necessary code changes, then provide a brief summary of what you did."
  );

  return lines.join("\n");
}
