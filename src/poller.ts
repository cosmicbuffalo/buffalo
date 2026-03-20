import { type RepoId, loadRepoConfig, getAllRepos } from "./config.js";
import { fetchPRComments, listOpenPRs, getPullRequest, postComment, reactToComment, deleteComment } from "./github.js";
import { loadSeenCommentIds, saveSeenCommentIds, loadSessions, getSession, setSession, removeSession } from "./session-store.js";
import { loadSeenIssueIds, saveSeenIssueIds, loadSeenIssueCommentIds, saveSeenIssueCommentIds } from "./issue-store.js";
import { ensureWorkspace, checkAndCleanupMergedPR, rollbackLastCommit } from "./repo-manager.js";
import { startCliSession, monitorSession, handleApproval, readSessionOutput } from "./cli-runner.js";
import { batchComments, buildPrompt, buildClarificationFollowUp, extractClarification, isControlComment, findLastTaskRequest } from "./batch.js";
import { appendHistory } from "./history.js";
import { isUndoCommand, isTryAgainCommand, extractTryAgainNote, findLastBotCommentId, rewriteLocalPaths } from "./comment-utils.js";
import { handlePRSessionCompletion, handleIssueSessionCompletion } from "./completion-handler.js";
import { pollIssues } from "./issue-poller.js";

// Re-export utilities that tests rely on
export { rewriteLocalPaths, isUndoCommand, isTryAgainCommand, extractTryAgainNote, findLastBotCommentId } from "./comment-utils.js";

let running = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Run one poll cycle for a single repo.
 */
async function pollRepo(id: RepoId): Promise<void> {
  const cfg = loadRepoConfig(id);

  try {
    const repoLabel = `${id.owner}/${id.repo}`;
    console.log(`[buffalo] Polling ${repoLabel}`);

    // List all open PRs and collect unaddressed bot-mention comments
    const openPRs = await listOpenPRs(id);
    console.log(`[buffalo] ${repoLabel}: ${openPRs.length} open PR(s)`);

    const seenIds = loadSeenCommentIds(id);
    const botTag = `@${cfg.botUsername}`;
    const allComments = (
      await Promise.all(openPRs.map((pr) => fetchPRComments(id, pr.number, botTag)))
    ).flat().filter((c) => !seenIds.has(c.id));
    allComments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    console.log(`[buffalo] ${repoLabel}: ${allComments.length} unaddressed comment(s) mentioning ${botTag}`);

    // Filter authorized users
    const authorized = allComments.filter((c) => cfg.authorizedUsers.includes(c.user));
    if (allComments.length > 0) {
      console.log(`[buffalo] ${repoLabel}: ${authorized.length} from authorized user(s)`);
    }

    // Check for approval responses
    for (const c of authorized) {
      const bodyLower = c.body.toLowerCase();
      if (bodyLower.includes("allow once")) {
        const sessions = loadSessions(id);
        for (const [branch, session] of Object.entries(sessions.sessions)) {
          if (session.prNumber === c.prNumber && session.pendingApproval) {
            handleApproval(id, branch, "allow_once");
            await reactToComment(id, c.id, "+1", c.commentType);
          }
        }
        seenIds.add(c.id);
        continue;
      }
      if (bodyLower.includes("allow always")) {
        const patternMatch = c.body.match(/allow always\s+`?([^`\n]+)`?/i);
        const pattern = patternMatch?.[1]?.trim();
        const sessions = loadSessions(id);
        for (const [branch, session] of Object.entries(sessions.sessions)) {
          if (session.prNumber === c.prNumber && session.pendingApproval) {
            handleApproval(id, branch, "allow_always", pattern);
            await reactToComment(id, c.id, "+1", c.commentType);
          }
        }
        seenIds.add(c.id);
        continue;
      }
      if (bodyLower.includes(`${`@${cfg.botUsername}`.toLowerCase()} deny`)) {
        const sessions = loadSessions(id);
        for (const [branch, session] of Object.entries(sessions.sessions)) {
          if (session.prNumber === c.prNumber && session.pendingApproval) {
            handleApproval(id, branch, "deny");
            await reactToComment(id, c.id, "+1", c.commentType);
          }
        }
        seenIds.add(c.id);
        continue;
      }
      if (isUndoCommand(c.body, cfg.botUsername)) {
        try {
          const pr = await getPullRequest(id, c.prNumber);
          ensureWorkspace(id, pr.branch, pr.cloneUrl);
          const newHead = rollbackLastCommit(id, pr.branch);
          // Delete the bot's previous comment so the bad response doesn't linger.
          const staleCommentId = findLastBotCommentId(id, pr.branch, c.prNumber);
          if (staleCommentId) await deleteComment(id, staleCommentId);
          await reactToComment(id, c.id, "+1", c.commentType);
          await postComment(
            id,
            c.prNumber,
            `@${c.user} Rolled back the latest Buffalo commit on \`${pr.branch}\` and force-pushed. New HEAD is \`${newHead}\`.`
          );
          appendHistory(id, pr.branch, {
            type: "undo_applied",
            pr: c.prNumber,
            trigger_comment_id: c.id,
            by: c.user,
            head_after: newHead,
          });
        } catch (err: any) {
          await postComment(
            id,
            c.prNumber,
            `@${c.user} I couldn't roll back the last commit: ${err?.message ?? "unknown error"}`
          );
        }
        seenIds.add(c.id);
        continue;
      }
      if (isTryAgainCommand(c.body, cfg.botUsername)) {
        try {
          const pr = await getPullRequest(id, c.prNumber);
          const cwd = ensureWorkspace(id, pr.branch, pr.cloneUrl);
          const newHead = rollbackLastCommit(id, pr.branch);
          // Delete the bot's previous comment so the bad response doesn't linger.
          const staleCommentId = findLastBotCommentId(id, pr.branch, c.prNumber);
          if (staleCommentId) await deleteComment(id, staleCommentId);
          const original = findLastTaskRequest(id, pr.branch, c.prNumber, cfg.botUsername);
          const note = extractTryAgainNote(c.body);
          const originalBody = original
            ? original.replace(new RegExp(`@${cfg.botUsername}`, "gi"), "").trim()
            : "(original request not found in history)";
          const retryBody = [
            `@${cfg.botUsername} Retry the previous request using a different approach.`,
            `Original request: ${originalBody}`,
            note ? `Additional guidance: ${note}` : null,
          ].filter(Boolean).join("\n");

          const retryBatch = {
            prNumber: c.prNumber,
            branch: pr.branch,
            comments: [{
              ...c,
              body: retryBody,
            }],
          };

          startCliSession(id, pr.branch, buildPrompt(retryBatch, `@${cfg.botUsername}`), cwd, c.prNumber);
          setSession(id, pr.branch, {
            branch: pr.branch,
            prNumber: c.prNumber,
            commentIds: [c.id],
            triggerComments: [{
              user: c.user,
              body: c.body,
              commentId: c.id,
              commentType: c.commentType,
            }],
            status: "running",
            logOffset: 0,
          });

          await reactToComment(id, c.id, "+1", c.commentType);
          await postComment(
            id,
            c.prNumber,
            `@${c.user} Rolled back the previous attempt on \`${pr.branch}\` (new HEAD \`${newHead}\`) and started a retry with your guidance.`
          );
          appendHistory(id, pr.branch, {
            type: "retry_started",
            pr: c.prNumber,
            trigger_comment_id: c.id,
            by: c.user,
            original_request: originalBody,
            note: note ?? "",
            head_after_undo: newHead,
          });
        } catch (err: any) {
          await postComment(
            id,
            c.prNumber,
            `@${c.user} I couldn't start a retry: ${err?.message ?? "unknown error"}`
          );
        }
        seenIds.add(c.id);
        continue;
      }
    }

    // Filter out approval responses for batching — only new task comments
    const taskComments = authorized.filter((c) => {
      return !isControlComment(c.body, cfg.botUsername);
    });

    if (taskComments.length > 0) {
      // Build branch map from PR details
      const branchMap = new Map<number, string>();
      const prNumbers = [...new Set(taskComments.map((c) => c.prNumber))];

      for (const prNum of prNumbers) {
        const pr = await getPullRequest(id, prNum);
        branchMap.set(prNum, pr.branch);
      }

      // Batch comments by PR
      const batches = batchComments(taskComments, branchMap);

      for (const batch of batches) {
        // Log comment detection and tentatively mark seen.
        // If anything below fails, we'll roll back these IDs.
        for (const c of batch.comments) {
          appendHistory(id, batch.branch, {
            type: "comment_detected",
            pr: batch.prNumber,
            comment_id: c.id,
            author: c.user,
            body: c.body,
          });
          await reactToComment(id, c.id, "eyes", c.commentType);
          seenIds.add(c.id);
        }

        try {
          // Ensure workspace
          const pr = await getPullRequest(id, batch.prNumber);
          const cwd = ensureWorkspace(id, batch.branch, pr.cloneUrl);

          const existing = getSession(id, batch.branch);

          if (existing?.status === "waiting_clarification" && existing.pendingClarification) {
            // The new comment is a clarification answer — resume the original task.
            const followUpPrompt = buildClarificationFollowUp(existing, batch, `@${cfg.botUsername}`);
            startCliSession(id, batch.branch, followUpPrompt, cwd, batch.prNumber);
            setSession(id, batch.branch, {
              branch: batch.branch,
              prNumber: batch.prNumber,
              commentIds: [...existing.commentIds, ...batch.comments.map((c) => c.id)],
              triggerComments: [
                ...(existing.triggerComments ?? []),
                ...batch.comments.map((c) => ({ user: c.user, body: c.body, commentId: c.id, commentType: c.commentType })),
              ],
              status: "running",
              logOffset: 0,
            });
            appendHistory(id, batch.branch, {
              type: "clarification_answered",
              pr: batch.prNumber,
              answer: batch.comments.map((c) => c.body).join("\n"),
            });
          } else if (existing?.status === "running") {
            // Session already running — send the new comment as additional input.
            const tmux = await import("./tmux-manager.js");
            tmux.sendKeys(id, batch.branch, buildPrompt(batch, `@${cfg.botUsername}`));
          } else {
            // Fresh session.
            startCliSession(id, batch.branch, buildPrompt(batch, `@${cfg.botUsername}`), cwd, batch.prNumber);
            setSession(id, batch.branch, {
              branch: batch.branch,
              prNumber: batch.prNumber,
              commentIds: batch.comments.map((c) => c.id),
              triggerComments: batch.comments.map((c) => ({
                user: c.user,
                body: c.body,
                commentId: c.id,
                commentType: c.commentType,
              })),
              status: "running",
              logOffset: 0,
            });
          }
        } catch (err) {
          console.error(`[buffalo] Failed to start session for ${batch.branch}, will retry:`, err);
          for (const c of batch.comments) seenIds.delete(c.id);
        }
      }
    }

    // Monitor active sessions
    const sessions = loadSessions(id);
    for (const [branch, session] of Object.entries(sessions.sessions)) {
      if (session.status === "paused") continue;
      if (session.status === "waiting_approval") continue;
      if (session.status === "waiting_clarification") continue;

      const result = await monitorSession(id, branch);

      if (result === "completed") {
        const { response, tokensUsed } = readSessionOutput(id, branch);

        // Check if the agent is asking for clarification before committing.
        const clarificationQuestion = extractClarification(response);
        if (clarificationQuestion) {
          const triggers = session.triggerComments ?? [];
          const mentions = [...new Set(triggers.map((c) => `@${c.user}`))].join(" ");
          const commentId = await postComment(
            id,
            session.prNumber,
            `${mentions ? `${mentions}\n\n` : ""}I need some clarification before I can proceed:\n\n${clarificationQuestion}\n\nPlease reply mentioning \`@${cfg.botUsername}\` with your answer.`
          );
          setSession(id, branch, {
            ...session,
            status: "waiting_clarification",
            pendingClarification: { question: clarificationQuestion, commentId },
          });
          appendHistory(id, branch, {
            type: "clarification_requested",
            pr: session.prNumber,
            question: clarificationQuestion,
            comment_id: commentId,
          });
          console.log(`[buffalo] Session for ${branch} waiting for clarification.`);
          continue; // leave session in store, don't commit or post completion comment
        }

        if (session.issueNumber !== undefined) {
          await handleIssueSessionCompletion(id, branch, session, response, tokensUsed, cfg);
        } else {
          await handlePRSessionCompletion(id, branch, session, response, tokensUsed, cfg, seenIds);
        }

        removeSession(id, branch);
      }
    }

    // Check for merged PRs (skip issue sessions — prNumber is the issue number, not a PR)
    const allSessions = loadSessions(id);
    const trackedPRs = new Set(
      Object.values(allSessions.sessions)
        .filter((s) => s.issueNumber === undefined)
        .map((s) => s.prNumber)
    );
    for (const prNum of trackedPRs) {
      const branch = Object.entries(allSessions.sessions).find(
        ([, s]) => s.prNumber === prNum && s.issueNumber === undefined
      )?.[0];
      if (branch) {
        await checkAndCleanupMergedPR(id, prNum, branch);
      }
    }

    saveSeenCommentIds(id, seenIds);

    // Poll issues
    const seenIssueIds = loadSeenIssueIds(id);
    const seenIssueCommentIds = loadSeenIssueCommentIds(id);
    await pollIssues(id, cfg, seenIssueIds, seenIssueCommentIds);
    saveSeenIssueIds(id, seenIssueIds);
    saveSeenIssueCommentIds(id, seenIssueCommentIds);
  } catch (err) {
    console.error(`[buffalo] Error polling ${id.owner}/${id.repo}:`, err);
    throw err;
  }
}

/**
 * Start the poll loop for specified repos (or all configured repos).
 */
export function startPolling(repos?: RepoId[]): void {
  const targets = repos ?? getAllRepos();
  if (targets.length === 0) {
    console.error("[buffalo] No repos configured. Run `buffalo init` first.");
    return;
  }

  running = true;
  console.log(`[buffalo] Starting poll loop for ${targets.length} repo(s)`);

  const poll = async () => {
    if (!running) return;
    for (const id of targets) {
      try {
        await pollRepo(id);
      } catch (err) {
        console.error(`[buffalo] Fatal error — stopping poller.`);
        stopPolling();
        return;
      }
    }
    if (running) {
      const interval = Math.min(
        ...targets.map((t) => loadRepoConfig(t).pollIntervalMs),
        15 * 60 * 1000
      );
      pollTimer = setTimeout(poll, interval);
    }
  };

  poll();
}

/**
 * Stop the poll loop.
 */
export function stopPolling(): void {
  running = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  console.log("[buffalo] Polling stopped.");
}
