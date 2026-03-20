import * as fs from "node:fs";
import * as path from "node:path";
import { type RepoId, loadRepoConfig, getAllRepos, workspaceDir, daemonErrorLog, ensureDir } from "./config.js";
import { fetchPRComments, listOpenPRs, getPullRequest, postComment, postReviewCommentReply, reactToComment, listOpenIssues, fetchIssueComments, getDefaultBranch, createPullRequest, reactToIssue, deleteComment } from "./github.js";
import { loadSeenCommentIds, saveSeenCommentIds, loadSessions, getSession, setSession, removeSession, markBranchResumable, clearBranchResumable } from "./session-store.js";
import { loadSeenIssueIds, saveSeenIssueIds, loadSeenIssueCommentIds, saveSeenIssueCommentIds, getIssuePr, setIssuePr } from "./issue-store.js";
import { ensureWorkspace, commitAndPush, checkAndCleanupMergedPR, createIssueBranch, checkoutNewBranch, renameWorkspaceDir, rollbackLastCommit } from "./repo-manager.js";
import { startCliSession, monitorSession, handleApproval, readSessionOutput } from "./cli-runner.js";
import { batchComments, buildPrompt, buildClarificationFollowUp, buildIssuePrompt, buildIssueFollowUpPrompt, extractCommitMessage, extractClarification, extractPerCommentResponses, extractBranchName, extractPRTitle, stripDirectives } from "./batch.js";
import { appendHistory, readHistory } from "./history.js";

let running = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000;
const MIN_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 15 * 60 * 1000;

interface RepoPollState {
  id: RepoId;
  intervalMs: number;
  failureCount: number;
  nextPollAt: number;
  lastErrorAt?: number;
  lastError?: string;
}

const pollerStates = new Map<string, RepoPollState>();

type PollerErrorKind =
  | "repo_poll_error"
  | "repo_poll_recovered"
  | "poller_stopped"
  | "poller_started"
  | "poller_fatal_error";

interface PollerErrorEvent {
  ts: string;
  kind: PollerErrorKind;
  repo?: string;
  message: string;
}

interface PollerStatus {
  repo: RepoId;
  intervalMs: number;
  failureCount: number;
  nextPollAt: number;
  lastError?: string;
  lastErrorAt?: number;
}

function commitLink(id: RepoId, sha: string): string {
  return `[\`${sha}\`](https://github.com/${id.owner}/${id.repo}/commit/${sha})`;
}

function repoKey(id: RepoId): string {
  return `${id.owner}/${id.repo}`;
}

function parseErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  try {
    return String((err as { message?: unknown })?.message ?? err);
  } catch {
    return "Unknown error";
  }
}

function logPollerError(kind: PollerErrorKind, repo: RepoId | null, err: unknown): void {
  const event: PollerErrorEvent = {
    ts: new Date().toISOString(),
    kind,
    message: parseErrorMessage(err),
  };

  if (repo) event.repo = repoKey(repo);
  try {
    ensureDir(path.dirname(daemonErrorLog()));
  } catch {}

  try {
    fs.appendFileSync(daemonErrorLog(), `${JSON.stringify(event)}\n`);
  } catch {
    // Non-critical: best-effort visibility into poller errors.
  }
}

function computeBackoffMs(state: RepoPollState): number {
  const fail = Math.max(1, state.failureCount);
  const base = Math.max(state.intervalMs, MIN_RETRY_DELAY_MS);
  const exponential = base * Math.pow(2, fail - 1);
  return Math.min(exponential, MAX_RETRY_DELAY_MS);
}

function getState(id: RepoId): RepoPollState {
  const key = repoKey(id);
  const existing = pollerStates.get(key);
  if (existing) return existing;

  const intervalMs = loadRepoConfig(id).pollIntervalMs;
  const state: RepoPollState = {
    id,
    intervalMs,
    failureCount: 0,
    nextPollAt: Date.now(),
  };
  pollerStates.set(key, state);
  return state;
}

function formatDelay(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

function markRepoFailure(id: RepoId, err: unknown): RepoPollState {
  const state = getState(id);
  state.failureCount += 1;
  state.lastErrorAt = Date.now();
  state.lastError = parseErrorMessage(err);
  state.nextPollAt = Date.now() + computeBackoffMs(state);

  console.warn(
    `[buffalo] Polling ${repoKey(id)} failed (${state.failureCount} consecutive failure(s)). ` +
    `Retry in ${formatDelay(state.nextPollAt - Date.now())}s. Error: ${state.lastError}`
  );
  logPollerError("repo_poll_error", id, err);
  return state;
}

function markRepoRecovered(id: RepoId): RepoPollState {
  const state = getState(id);
  if (state.failureCount > 0) {
    const previous = state.failureCount;
    state.failureCount = 0;
    state.lastError = undefined;
    state.lastErrorAt = undefined;
    logPollerError("repo_poll_recovered", id, `Recovered after ${previous} failure(s).`);
  }
  state.nextPollAt = Date.now() + state.intervalMs;
  return state;
}

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

function isUndoCommand(body: string, botUsername: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes(`@${botUsername.toLowerCase()} undo`);
}

function isTryAgainCommand(body: string, botUsername: string): boolean {
  const lower = body.toLowerCase();
  const bot = `@${botUsername.toLowerCase()}`;
  return lower.includes(`${bot} try again`) || lower.includes(`${bot} retry`);
}

function isControlComment(body: string, botUsername: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("allow once") ||
    lower.includes("allow always") ||
    lower.includes(`@${botUsername.toLowerCase()} deny`) ||
    isUndoCommand(body, botUsername) ||
    isTryAgainCommand(body, botUsername)
  );
}

function extractTryAgainNote(body: string): string | null {
  const match = body.match(/(?:try again|retry)[:\s-]*(.*)$/i);
  const note = match?.[1]?.trim() ?? "";
  return note.length > 0 ? note : null;
}

/**
 * Find the comment ID of the last comment posted by the bot on a given branch/PR.
 * Used by try-again and undo to delete the stale response before retrying.
 */
function findLastBotCommentId(id: RepoId, branch: string, prNumber: number): number | null {
  const events = readHistory(id, branch).slice().reverse();
  for (const e of events) {
    if (e.type !== "comment_posted") continue;
    if (e.pr !== prNumber) continue;
    if (typeof e.comment_id === "number") return e.comment_id;
  }
  return null;
}

function findLastTaskRequest(id: RepoId, branch: string, prNumber: number, botUsername: string): string | null {
  const events = readHistory(id, branch).slice().reverse();
  for (const e of events) {
    if (e.type !== "comment_detected") continue;
    if (e.pr !== prNumber) continue;
    const body = typeof e.body === "string" ? e.body : "";
    if (!body) continue;
    if (isControlComment(body, botUsername)) continue;
    return body;
  }
  return null;
}

/**
 * Poll open issues for bot mentions and route them to CLI sessions.
 */
async function pollIssues(
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
              commentIds: [],
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
              commentIds: [],
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
              commentIds: [],
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
          const cwd = ensureWorkspace(id, pr.branch, pr.cloneUrl);
          // cwd is intentionally computed first to guarantee branch workspace exists.
          void cwd;
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
      const lower = c.body.toLowerCase();
      return (
        !isControlComment(c.body, cfg.botUsername)
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
          // ── Issue session completion ──────────────────────────────────────
          await handleIssueSessionCompletion(id, branch, session, response, tokensUsed, cfg);
        } else {
          // ── PR session completion (existing behavior) ─────────────────────
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
 * Handle completion of an issue-originated session.
 */
async function handleIssueSessionCompletion(
  id: RepoId,
  branch: string,
  session: import("./session-store.js").SessionInfo,
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
        const prLinkCommentId = await postComment(
          id,
          n,
          `I've opened a PR to address this: ${prUrl}\n\nCommitted as ${commitLink(id, sha)}.`
        );

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
async function handlePRSessionCompletion(
  id: RepoId,
  branch: string,
  session: import("./session-store.js").SessionInfo,
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
  if (sha) sharedParts.push(`Pushed commit ${commitLink(id, sha)}.`);
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
            ...(sha ? ["", `Pushed commit ${commitLink(id, sha)}.`] : []),
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
    const opener = sha ? `${mentions} Pushed commit ${commitLink(id, sha)}.`.trim() : mentions;
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

/**
 * Start the poll loop for specified repos (or all configured repos).
 */
export function getPollerStatuses(): PollerStatus[] {
  return Array.from(pollerStates.values()).map((state) => ({
    repo: state.id,
    intervalMs: state.intervalMs,
    failureCount: state.failureCount,
    nextPollAt: state.nextPollAt,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
  }));
}

export function getPollerStatus(id: RepoId): PollerStatus | null {
  const state = pollerStates.get(repoKey(id));
  if (!state) return null;
  return {
    repo: state.id,
    intervalMs: state.intervalMs,
    failureCount: state.failureCount,
    nextPollAt: state.nextPollAt,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
  };
}

export function getRecentPollerErrors(limit = 10): PollerErrorEvent[] {
  try {
    const raw = fs.readFileSync(daemonErrorLog(), "utf-8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as PollerErrorEvent;
        } catch {
          return {
            ts: new Date().toISOString(),
            kind: "poller_fatal_error" as const,
            message: line,
          };
        }
      });
  } catch {
    return [];
  }
}

export function startPolling(repos?: RepoId[]): void {
  const targets = repos ?? getAllRepos();
  if (targets.length === 0) {
    console.error("[buffalo] No repos configured. Run `buffalo init` first.");
    return;
  }

  const activeTargets: RepoId[] = [];
  for (const id of targets) {
    try {
      const intervalMs = loadRepoConfig(id).pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
      const state = getState(id);
      state.failureCount = 0;
      state.lastError = undefined;
      state.lastErrorAt = undefined;
      state.nextPollAt = Date.now();
      state.intervalMs = intervalMs;
      activeTargets.push(id);
    } catch (err) {
      console.error(`[buffalo] Failed to initialize poller for ${repoKey(id)}:`, err);
      logPollerError("repo_poll_error", id, err);
    }
  }

  if (activeTargets.length === 0) {
    console.error("[buffalo] No repos could be initialized for polling.");
    return;
  }

  running = true;
  const skipped = targets.length - activeTargets.length;
  if (skipped > 0) {
    console.warn(`[buffalo] Skipped ${skipped} repo(s) due to errors during initialization.`);
  }

  logPollerError("poller_started", activeTargets[0], `${activeTargets.length} repo(s)`);
  console.log(`[buffalo] Starting poll loop for ${activeTargets.length} repo(s)`);

  const poll = async () => {
    if (!running) return;
    let nextDelayMs = DEFAULT_POLL_INTERVAL_MS;

    try {
      const now = Date.now();
      for (const id of activeTargets) {
        const state = getState(id);
        if (state.nextPollAt > now) {
          nextDelayMs = Math.min(nextDelayMs, state.nextPollAt - now);
          continue;
        }

        try {
          await pollRepo(id);
          const recovered = markRepoRecovered(id);
          nextDelayMs = Math.min(nextDelayMs, recovered.intervalMs);
        } catch (err) {
          const failed = markRepoFailure(id, err);
          nextDelayMs = Math.min(nextDelayMs, failed.nextPollAt - Date.now());
        }
      }
    } catch (err) {
      console.error(`[buffalo] Fatal error — stopping poller.`);
      logPollerError("poller_fatal_error", null, err);
      stopPolling();
      return;
    }
    if (running) {
      pollTimer = setTimeout(poll, Math.max(1_000, nextDelayMs));
    }
  };

  poll();
}

/**
 * Stop the poll loop.
 */
export function stopPolling(): void {
  if (!running) {
    console.log("[buffalo] Polling stopped.");
    return;
  }

  running = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  logPollerError("poller_stopped", null, "Polling stopped by command.");
  console.log("[buffalo] Polling stopped.");
}
