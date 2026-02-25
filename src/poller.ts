import { type RepoId, loadRepoConfig, getAllRepos, workspaceDir } from "./config.js";
import { fetchPRComments, listOpenPRs, getPullRequest, postComment, reactToComment } from "./github.js";
import { loadSeenCommentIds, saveSeenCommentIds, loadSessions, getSession, setSession, removeSession, markBranchResumable, clearBranchResumable } from "./session-store.js";
import { ensureWorkspace, commitAndPush, checkAndCleanupMergedPR } from "./repo-manager.js";
import { startCliSession, monitorSession, handleApproval, readSessionOutput } from "./cli-runner.js";
import { batchComments, buildPrompt, buildClarificationFollowUp, extractCommitMessage, extractClarification, stripDirectives } from "./batch.js";
import { appendHistory } from "./history.js";

let running = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Replace local workspace file paths in markdown links with GitHub blob URLs.
 * Codex writes links using the absolute local workspace path; we rewrite them
 * to https://github.com/<owner>/<repo>/blob/<branch>/<relative-path>.
 */
function rewriteLocalPaths(text: string, id: RepoId, branch: string): string {
  const base = workspaceDir(id, branch);
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Rewrite markdown links with local paths to GitHub blob URLs
  let result = text.replace(
    new RegExp(`\\[([^\\]]+)\\]\\(${escaped}/([^)]+)\\)`, "g"),
    (_, linkText, relPath) =>
      `[${linkText}](https://github.com/${id.owner}/${id.repo}/blob/${branch}/${relPath})`
  );

  // Strip the workspace prefix from any remaining bare paths, leaving just the relative path
  result = result.replace(new RegExp(`${escaped}/`, "g"), "");

  return result;
}

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
            await reactToComment(id, c.id, "+1");
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
            await reactToComment(id, c.id, "+1");
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
            await reactToComment(id, c.id, "+1");
          }
        }
        seenIds.add(c.id);
        continue;
      }
    }

    // Filter out approval responses for batching — only new task comments
    const taskComments = authorized.filter((c) => {
      const lower = c.body.toLowerCase();
      return (
        !lower.includes("allow once") &&
        !lower.includes("allow always") &&
        !lower.includes(`${`@${cfg.botUsername}`.toLowerCase()} deny`)
      );
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
          await reactToComment(id, c.id, "eyes");
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
                ...batch.comments.map((c) => ({ user: c.user, body: c.body })),
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

        // Build the comment. Format:
        //   > @user: original comment (quoted)
        //
        //   @user Pushed commit `sha`. (or just @user if no commit)
        //   #### Tokens used: N
        //   #### Codex's response:
        //   <response text>
        const triggers = session.triggerComments ?? [];
        const botTag = `@${cfg.botUsername}`;

        const quoteLines = triggers.flatMap((c) => {
          const body = c.body.replace(new RegExp(botTag, "gi"), "").trim();
          return body.split("\n").map((l) => `> ${l}`);
        });

        const mentions = [...new Set(triggers.map((c) => `@${c.user}`))].join(" ");

        const parts: string[] = [];
        if (quoteLines.length > 0) {
          parts.push(quoteLines.join("\n"));
          parts.push("");
        }

        const opener = sha
          ? `${mentions} Pushed commit \`${sha}\`.`.trim()
          : mentions;
        if (opener) parts.push(opener);

        if (tokensUsed != null) {
          parts.push("");
          parts.push(`#### Tokens used: ${tokensUsed.toLocaleString()}`);
        }

        const displayResponse = stripDirectives(
          response ? rewriteLocalPaths(response, id, branch) : null
        );
        if (displayResponse) {
          parts.push("");
          const backendName = cfg.backend === "claude" ? "Claude" : "Codex";
          parts.push(`## ${backendName}'s response:`);
          parts.push("");
          parts.push(displayResponse);
        }

        const commentBody = parts.join("\n").trim() || null;

        if (commentBody) {
          const commentId = await postComment(id, session.prNumber, commentBody);
          appendHistory(id, branch, {
            type: "comment_posted",
            pr: session.prNumber,
            comment_id: commentId,
          });
          // Session produced output — keep codex context alive for follow-ups.
          markBranchResumable(id, branch);
        } else {
          // No output at all — session likely failed or codex never ran. Clear
          // resume state so the next attempt starts fresh, and un-see comment IDs
          // so they'll be retried on the next poll.
          clearBranchResumable(id, branch);
          console.log(`[buffalo] Session for ${branch} produced no response — marking comments for retry.`);
          for (const commentId of session.commentIds) seenIds.delete(commentId);
        }

        removeSession(id, branch);
      }
    }

    // Check for merged PRs
    const allSessions = loadSessions(id);
    const trackedPRs = new Set(
      Object.values(allSessions.sessions).map((s) => s.prNumber)
    );
    for (const prNum of trackedPRs) {
      const branch = Object.entries(allSessions.sessions).find(
        ([, s]) => s.prNumber === prNum
      )?.[0];
      if (branch) {
        await checkAndCleanupMergedPR(id, prNum, branch);
      }
    }

    saveSeenCommentIds(id, seenIds);
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
      const interval = targets[0]
        ? loadRepoConfig(targets[0]).pollIntervalMs
        : 15 * 60 * 1000;
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
