import { type RepoId, loadRepoConfig, getAllRepos } from "./config.js";
import { fetchNewComments, getPullRequest, postComment, reactToComment } from "./github.js";
import { loadLastPoll, saveLastPoll, loadSessions, getSession, setSession } from "./session-store.js";
import { ensureWorkspace, commitAndPush, checkAndCleanupMergedPR } from "./repo-manager.js";
import { startCliSession, monitorSession, handleApproval } from "./cli-runner.js";
import { batchComments, buildPrompt } from "./batch.js";
import { appendHistory } from "./history.js";

let running = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Run one poll cycle for a single repo.
 */
async function pollRepo(id: RepoId): Promise<void> {
  const cfg = loadRepoConfig(id);
  const lastPoll = loadLastPoll(id) ?? new Date(Date.now() - cfg.pollIntervalMs).toISOString();
  const now = new Date().toISOString();

  try {
    // Fetch new comments mentioning bot
    const comments = await fetchNewComments(id, lastPoll, cfg.botTag);

    // Filter authorized users
    const authorized = comments.filter((c) =>
      cfg.authorizedUsers.includes(c.user)
    );

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
        continue;
      }
      if (bodyLower.includes(`${cfg.botTag.toLowerCase()} deny`)) {
        const sessions = loadSessions(id);
        for (const [branch, session] of Object.entries(sessions.sessions)) {
          if (session.prNumber === c.prNumber && session.pendingApproval) {
            handleApproval(id, branch, "deny");
            await reactToComment(id, c.id, "+1");
          }
        }
        continue;
      }
    }

    // Filter out approval responses for batching — only new task comments
    const taskComments = authorized.filter((c) => {
      const lower = c.body.toLowerCase();
      return (
        !lower.includes("allow once") &&
        !lower.includes("allow always") &&
        !lower.includes(`${cfg.botTag.toLowerCase()} deny`)
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
        // Log comment detection
        for (const c of batch.comments) {
          appendHistory(id, batch.branch, {
            type: "comment_detected",
            pr: batch.prNumber,
            comment_id: c.id,
            author: c.user,
            body: c.body,
          });
          await reactToComment(id, c.id, "eyes");
        }

        // Ensure workspace
        const pr = await getPullRequest(id, batch.prNumber);
        const cwd = ensureWorkspace(id, batch.branch, pr.cloneUrl);

        // Build prompt
        const prompt = buildPrompt(batch, cfg.botTag);

        // Check if there's already an active session
        const existing = getSession(id, batch.branch);
        if (existing && existing.status === "running") {
          // Send follow-up to existing session
          // Send follow-up to existing session
          const tmux = await import("./tmux-manager.js");
          tmux.sendKeys(id, batch.branch, prompt);
        } else {
          // Start new CLI session
          startCliSession(id, batch.branch, prompt, cwd, batch.prNumber);

          setSession(id, batch.branch, {
            branch: batch.branch,
            prNumber: batch.prNumber,
            commentIds: batch.comments.map((c) => c.id),
            status: "running",
            logOffset: 0,
          });
        }
      }
    }

    // Monitor active sessions
    const sessions = loadSessions(id);
    for (const [branch, session] of Object.entries(sessions.sessions)) {
      if (session.status === "paused") continue;
      if (session.status === "waiting_approval") continue;

      const result = await monitorSession(id, branch);

      if (result === "completed") {
        // Try to commit and push
        const sha = commitAndPush(id, branch, `buffalo: address PR #${session.prNumber} feedback`);
        if (sha) {
          appendHistory(id, branch, {
            type: "commit_pushed",
            pr: session.prNumber,
            sha,
            message: `buffalo: address PR #${session.prNumber} feedback`,
          });

          const commentId = await postComment(
            id,
            session.prNumber,
            `Done! Pushed commit \`${sha}\` to address the feedback.`
          );

          appendHistory(id, branch, {
            type: "comment_posted",
            pr: session.prNumber,
            comment_id: commentId,
          });
        }
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
  } catch (err) {
    console.error(`[buffalo] Error polling ${id.owner}/${id.repo}:`, err);
  }

  saveLastPoll(id, now);
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
      await pollRepo(id);
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
