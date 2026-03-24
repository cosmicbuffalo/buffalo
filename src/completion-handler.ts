import { type RepoId, loadRepoConfig } from "./config.js";
import { postComment, postReviewCommentReply, getDefaultBranch, createPullRequest } from "./github.js";
import { type SessionInfo, markBranchResumable, clearBranchResumable } from "./session-store.js";
import { setIssuePr } from "./issue-store.js";
import { commitAndPush, checkoutNewBranch, renameWorkspaceDir } from "./repo-manager.js";
import { extractCommitMessage, extractPerCommentResponses, extractBranchName, extractPRTitle, stripDirectives } from "./batch.js";
import { appendHistory } from "./history.js";
import { rewriteLocalPaths } from "./comment-utils.js";

/**
 * Handle completion of an issue-originated session.
 */
export async function handleIssueSessionCompletion(
  id: RepoId,
  branch: string,
  session: SessionInfo,
  response: string | null,
  tokensUsed: number | null,
  cfg: ReturnType<typeof loadRepoConfig>
): Promise<void> {
  const n = session.issueNumber!;
  const finalBranchName = extractBranchName(response);

  if (finalBranchName) {
    // Agent made code changes and provided a branch name
    const commitMsg = extractCommitMessage(response) ?? `buffalo: address issue #${n}`;

    try {
      // Create the git branch from current working-tree state, rename workspace
      checkoutNewBranch(id, branch, finalBranchName);
      renameWorkspaceDir(id, branch, finalBranchName);

      const sha = commitAndPush(id, finalBranchName, commitMsg);
      if (sha) {
        const defaultBranch = await getDefaultBranch(id);
        const prTitle =
          extractPRTitle(response) ??
          (session.issueTitle ? `Resolve issue #${n}: ${session.issueTitle}` : `Resolve issue #${n}`);
        const prBodyText = stripDirectives(response) ?? "";
        const prBody = `${prBodyText}\n\nFixes #${n}`.trim();

        const { number: prNumber, url: prUrl } = await createPullRequest(
          id,
          finalBranchName,
          defaultBranch,
          prTitle,
          prBody
        );

        setIssuePr(id, n, prNumber, finalBranchName);
        const prLinkCommentId = await postComment(id, n, `I've opened a PR to address this: ${prUrl}`);

        appendHistory(id, branch, {
          type: "comment_posted",
          pr: n,
          comment_id: prLinkCommentId,
        });
        appendHistory(id, finalBranchName, {
          type: "pr_opened",
          pr: prNumber,
          issue: n,
          sha,
        });

        console.log(`[buffalo] Opened PR #${prNumber} for issue #${n}: ${prUrl}`);
      } else {
        // No changes detected — post the response as a comment
        const displayResponse = stripDirectives(response ? rewriteLocalPaths(response, id, finalBranchName) : null);
        if (displayResponse) {
          const commentId = await postComment(id, n, displayResponse);
          appendHistory(id, branch, { type: "comment_posted", pr: n, comment_id: commentId });
        }
      }
    } catch (err) {
      console.error(`[buffalo] Failed to create branch/PR for issue #${n}:`, err);
      // Try to post an error note
      try {
        await postComment(id, n, `Sorry, I encountered an error while processing this issue. Please try again.`);
      } catch {}
    }
  } else {
    // Agent answered without making code changes
    const commitMsg = extractCommitMessage(response) ?? `buffalo: address issue #${n}`;
    // Attempt to commit any incidental changes (usually null)
    commitAndPush(id, branch, commitMsg);

    const displayResponse = stripDirectives(
      response ? rewriteLocalPaths(response, id, branch) : null
    );
    if (displayResponse) {
      const commentId = await postComment(id, n, displayResponse);
      appendHistory(id, branch, { type: "comment_posted", pr: n, comment_id: commentId });
    }
  }
}

/**
 * Handle completion of a PR-originated session (existing behavior).
 */
export async function handlePRSessionCompletion(
  id: RepoId,
  branch: string,
  session: SessionInfo,
  response: string | null,
  tokensUsed: number | null,
  cfg: ReturnType<typeof loadRepoConfig>,
  seenIds: Set<number>
): Promise<void> {
  // Use the commit message suggested by the agent if present, otherwise fall back.
  const commitMsg =
    extractCommitMessage(response) ?? `buffalo: address PR #${session.prNumber} feedback`;

  // Commit and push any changes the CLI made.
  const sha = commitAndPush(id, branch, commitMsg);
  if (sha) {
    appendHistory(id, branch, {
      type: "commit_pushed",
      pr: session.prNumber,
      sha,
      message: `buffalo: address PR #${session.prNumber} feedback`,
    });
  }

  const triggers = session.triggerComments ?? [];
  const botTag = `@${cfg.botUsername}`;
  const backendName = cfg.backend === "claude" ? "Claude" : "Codex";

  const displayResponse = stripDirectives(
    response ? rewriteLocalPaths(response, id, branch) : null
  );

  // Shared content used in every reply (commit sha, tokens, response).
  const sharedParts: string[] = [];
  if (sha) sharedParts.push(`Pushed commit \`${sha}\`.`);
  if (tokensUsed != null) {
    sharedParts.push("");
    sharedParts.push(`#### Tokens used: ${tokensUsed.toLocaleString()}`);
  }
  if (displayResponse) {
    sharedParts.push("");
    sharedParts.push(`## ${backendName}'s response:`);
    sharedParts.push("");
    sharedParts.push(displayResponse);
  }
  const sharedBody = sharedParts.join("\n").trim() || null;

  // Split triggers by type so we can reply inline vs top-level.
  const reviewTriggers = triggers.filter((t) => t.commentType === "review" && t.commentId);
  const issueTriggers  = triggers.filter((t) => t.commentType !== "review");

  let postedAny = false;

  // Reply directly to each inline review comment.
  // Use per-comment RESPONSE[id] text when available; fall back to sharedBody.
  if (reviewTriggers.length > 0) {
    const perComment = extractPerCommentResponses(response);
    for (const t of reviewTriggers) {
      const specificText = perComment?.get(t.commentId!);
      const replyBody = specificText
        ? [
            specificText,
            ...(sha ? ["", `Pushed commit \`${sha}\`.`] : []),
            ...(tokensUsed != null ? ["", `#### Tokens used: ${tokensUsed.toLocaleString()}`] : []),
          ].join("\n")
        : sharedBody;
      if (!replyBody) continue;
      const commentId = await postReviewCommentReply(id, session.prNumber, t.commentId!, replyBody);
      appendHistory(id, branch, { type: "comment_posted", pr: session.prNumber, comment_id: commentId });
      postedAny = true;
    }
  }

  // Post a top-level conversation comment for issue-thread triggers (or when
  // there are no triggers at all, e.g. a manually-started session).
  if (issueTriggers.length > 0 || reviewTriggers.length === 0) {
    const topTriggers = issueTriggers.length > 0 ? issueTriggers : triggers;
    const quoteLines = topTriggers.flatMap((c) => {
      const body = c.body.replace(new RegExp(botTag, "gi"), "").trim();
      return body.split("\n").map((l) => `> ${l}`);
    });
    const mentions = [...new Set(topTriggers.map((c) => `@${c.user}`))].join(" ");

    const parts: string[] = [];
    if (quoteLines.length > 0) { parts.push(quoteLines.join("\n")); parts.push(""); }
    const opener = sha ? `${mentions} Pushed commit \`${sha}\`.`.trim() : mentions;
    if (opener) parts.push(opener);
    if (tokensUsed != null) { parts.push(""); parts.push(`#### Tokens used: ${tokensUsed.toLocaleString()}`); }
    if (displayResponse) { parts.push(""); parts.push(`## ${backendName}'s response:`); parts.push(""); parts.push(displayResponse); }

    const topBody = parts.join("\n").trim() || null;
    if (topBody) {
      const commentId = await postComment(id, session.prNumber, topBody);
      appendHistory(id, branch, { type: "comment_posted", pr: session.prNumber, comment_id: commentId });
      postedAny = true;
    }
  }

  if (postedAny) {
    // Session produced output — keep context alive for follow-ups.
    markBranchResumable(id, branch);
  } else {
    // No output at all — session likely failed. Clear resume state and
    // un-see comment IDs so they'll be retried on the next poll.
    clearBranchResumable(id, branch);
    console.log(`[buffalo] Session for ${branch} produced no response — marking comments for retry.`);
    for (const commentId of session.commentIds) seenIds.delete(commentId);
  }
}
