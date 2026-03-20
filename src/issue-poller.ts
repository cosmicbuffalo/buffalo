import { type RepoId, loadRepoConfig } from "./config.js";
import { listOpenIssues, fetchIssueComments, getDefaultBranch, reactToComment, reactToIssue, deleteComment } from "./github.js";
import { getSession, setSession } from "./session-store.js";
import { getIssuePr } from "./issue-store.js";
import { ensureWorkspace, createIssueBranch, rollbackLastCommit } from "./repo-manager.js";
import { startCliSession } from "./cli-runner.js";
import { buildIssuePrompt, buildIssueFollowUpPrompt, buildClarificationFollowUp } from "./batch.js";
import { appendHistory } from "./history.js";
import { isTryAgainCommand, extractTryAgainNote, findLastBotCommentId } from "./comment-utils.js";

/**
 * Poll open issues for bot mentions and route them to CLI sessions.
 */
export async function pollIssues(
  id: RepoId,
  cfg: ReturnType<typeof loadRepoConfig>,
  seenIssueIds: Set<number>,
  seenIssueCommentIds: Set<number>
): Promise<void> {
  const botTag = `@${cfg.botUsername}`;
  const repoLabel = `${id.owner}/${id.repo}`;
  const cloneUrl = `https://github.com/${id.owner}/${id.repo}.git`;

  let openIssues;
  try {
    openIssues = await listOpenIssues(id);
  } catch (err) {
    console.warn(`[buffalo] ${repoLabel}: could not list issues:`, err);
    return;
  }

  console.log(`[buffalo] ${repoLabel}: ${openIssues.length} open issue(s)`);

  // Step 1: Check issue bodies for bot mentions
  for (const issue of openIssues) {
    if (seenIssueIds.has(issue.number)) continue;
    if (!issue.body?.includes(botTag)) continue;
    if (!cfg.authorizedUsers.includes(issue.user)) continue;

    console.log(`[buffalo] ${repoLabel}: issue #${issue.number} mentions ${botTag}`);

    // React to the issue
    await reactToIssue(id, issue.number, "eyes");
    seenIssueIds.add(issue.number);

    try {
      const defaultBranch = await getDefaultBranch(id);
      const tempBranch = `buffalo/issue-${issue.number}`;
      const cwd = createIssueBranch(id, tempBranch, defaultBranch, cloneUrl);

      const prompt = buildIssuePrompt(issue, botTag);
      startCliSession(id, tempBranch, prompt, cwd, issue.number, issue.number);
      setSession(id, tempBranch, {
        branch: tempBranch,
        prNumber: issue.number,
        commentIds: [],
        triggerComments: [{ user: issue.user, body: issue.body }],
        status: "running",
        logOffset: 0,
        issueNumber: issue.number,
        issueTitle: issue.title,
      });

      appendHistory(id, tempBranch, {
        type: "issue_session_started",
        issue: issue.number,
        branch: tempBranch,
      });
    } catch (err) {
      console.error(`[buffalo] Failed to start issue session for #${issue.number}:`, err);
      seenIssueIds.delete(issue.number);
    }
  }

  // Step 2: Check issue comments for bot mentions
  for (const issue of openIssues) {
    let comments;
    try {
      comments = await fetchIssueComments(id, issue.number, botTag);
    } catch {
      continue;
    }

    const newComments = comments.filter(
      (c) => !seenIssueCommentIds.has(c.id) && cfg.authorizedUsers.includes(c.user)
    );
    if (newComments.length === 0) continue;

    for (const c of newComments) {
      console.log(`[buffalo] ${repoLabel}: issue #${issue.number} comment ${c.id} mentions ${botTag}`);
      await reactToComment(id, c.id, "eyes", "issue");
      seenIssueCommentIds.add(c.id);

      // Handle "try again" specially: delete the bot's stale comment and restart.
      if (isTryAgainCommand(c.body, cfg.botUsername)) {
        try {
          const tempBranch = `buffalo/issue-${issue.number}`;
          const existingPr = getIssuePr(id, issue.number);
          const note = extractTryAgainNote(c.body);

          // Delete the bot's last comment on this issue so it doesn't linger.
          const staleCommentId = findLastBotCommentId(
            id,
            existingPr ? existingPr.branch : tempBranch,
            issue.number
          );
          if (staleCommentId) await deleteComment(id, staleCommentId);

          if (existingPr) {
            // Roll back the last commit on the PR branch and retry.
            const cwd = ensureWorkspace(id, existingPr.branch, cloneUrl);
            rollbackLastCommit(id, existingPr.branch);
            const sessionToUse = {
              branch: existingPr.branch,
              prNumber: issue.number,
              commentIds: [] as number[],
              triggerComments: getSession(id, existingPr.branch)?.triggerComments ?? [],
              status: "running" as const,
              logOffset: 0,
              issueNumber: issue.number,
              issueTitle: issue.title,
            };
            const retryComment = { ...c, body: [
              "Retry the previous request using a different approach.",
              note ? `Additional guidance: ${note}` : null,
            ].filter(Boolean).join("\n") };
            const prompt = buildIssueFollowUpPrompt(sessionToUse, [retryComment], botTag, existingPr);
            startCliSession(id, existingPr.branch, prompt, cwd, issue.number, issue.number);
            setSession(id, existingPr.branch, { ...sessionToUse, commentIds: [c.id], status: "running", logOffset: 0 });
          } else {
            // No PR yet — restart the issue session from scratch.
            const defaultBranch = await getDefaultBranch(id);
            const cwd = createIssueBranch(id, tempBranch, defaultBranch, cloneUrl);
            const existingSession = getSession(id, tempBranch);
            const sessionToUse = existingSession ?? {
              branch: tempBranch,
              prNumber: issue.number,
              commentIds: [] as number[],
              triggerComments: [{ user: issue.user, body: issue.body ?? "" }],
              status: "running" as const,
              logOffset: 0,
              issueNumber: issue.number,
              issueTitle: issue.title,
            };
            const retryComment = { ...c, body: [
              "Retry the previous request using a different approach.",
              note ? `Additional guidance: ${note}` : null,
            ].filter(Boolean).join("\n") };
            const prompt = buildIssueFollowUpPrompt(sessionToUse, [retryComment], botTag);
            startCliSession(id, tempBranch, prompt, cwd, issue.number, issue.number);
            setSession(id, tempBranch, {
              branch: tempBranch,
              prNumber: issue.number,
              commentIds: [c.id],
              triggerComments: sessionToUse.triggerComments,
              status: "running",
              logOffset: 0,
              issueNumber: issue.number,
              issueTitle: issue.title,
            });
          }

          appendHistory(id, existingPr ? existingPr.branch : tempBranch, {
            type: "retry_started",
            pr: issue.number,
            trigger_comment_id: c.id,
            by: c.user,
            note: note ?? "",
          });
        } catch (err: any) {
          console.error(`[buffalo] Failed to handle issue try-again for #${issue.number}:`, err);
          seenIssueCommentIds.delete(c.id);
        }
        continue;
      }

      try {
        const existingPr = getIssuePr(id, issue.number);

        if (existingPr) {
          // Route to the existing PR branch
          const cwd = ensureWorkspace(id, existingPr.branch, cloneUrl);
          const existing = getSession(id, existingPr.branch);

          if (existing?.status === "running") {
            // Session already running — send additional input
            const tmux = await import("./tmux-manager.js");
            tmux.sendKeys(
              id,
              existingPr.branch,
              buildIssueFollowUpPrompt(existing, [c], botTag, existingPr)
            );
          } else {
            // Start a new session on the existing PR branch
            const followUpSession = existing?.status === "waiting_clarification" && existing.pendingClarification
              ? existing
              : null;

            const prompt = followUpSession
              ? buildClarificationFollowUp(
                  followUpSession,
                  { prNumber: issue.number, branch: existingPr.branch, comments: [] as any },
                  botTag
                )
              : buildIssueFollowUpPrompt(
                  {
                    branch: existingPr.branch,
                    prNumber: issue.number,
                    commentIds: [],
                    triggerComments: [],
                    status: "running",
                    logOffset: 0,
                    issueNumber: issue.number,
                    issueTitle: issue.title,
                  },
                  [c],
                  botTag,
                  existingPr
                );

            startCliSession(id, existingPr.branch, prompt, cwd, issue.number, issue.number);
            setSession(id, existingPr.branch, {
              branch: existingPr.branch,
              prNumber: issue.number,
              commentIds: [c.id],
              triggerComments: [{ user: c.user, body: c.body }],
              status: "running",
              logOffset: 0,
              issueNumber: issue.number,
              issueTitle: issue.title,
            });
          }
        } else {
          // No existing PR — check if there's an active issue session
          const tempBranch = `buffalo/issue-${issue.number}`;
          const existing = getSession(id, tempBranch);

          if (existing?.status === "running") {
            // Send as additional input to the running session
            const tmux = await import("./tmux-manager.js");
            tmux.sendKeys(
              id,
              tempBranch,
              buildIssueFollowUpPrompt(existing, [c], botTag)
            );
          } else {
            // Start a fresh issue session
            const defaultBranch = await getDefaultBranch(id);
            const cwd = createIssueBranch(id, tempBranch, defaultBranch, cloneUrl);
            const sessionToUse = existing ?? {
              branch: tempBranch,
              prNumber: issue.number,
              commentIds: [] as number[],
              triggerComments: [{ user: issue.user, body: issue.body ?? "" }],
              status: "running" as const,
              logOffset: 0,
              issueNumber: issue.number,
              issueTitle: issue.title,
            };
            const prompt = buildIssueFollowUpPrompt(sessionToUse, [c], botTag);
            startCliSession(id, tempBranch, prompt, cwd, issue.number, issue.number);
            setSession(id, tempBranch, {
              branch: tempBranch,
              prNumber: issue.number,
              commentIds: [c.id],
              triggerComments: [
                ...(existing?.triggerComments ?? [{ user: issue.user, body: issue.body ?? "" }]),
                { user: c.user, body: c.body },
              ],
              status: "running",
              logOffset: 0,
              issueNumber: issue.number,
              issueTitle: issue.title,
            });
          }
        }
      } catch (err) {
        console.error(`[buffalo] Failed to handle issue comment ${c.id}:`, err);
        seenIssueCommentIds.delete(c.id);
      }
    }
  }
}
