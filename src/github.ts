import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type RepoId, loadGlobalConfig, loadRepoConfig } from "./config.js";

const execFileAsync = promisify(execFile);

/** Run gh and parse JSON output. Pass botToken to authenticate as the bot account. */
async function ghJson<T>(args: string[], botToken?: string): Promise<T> {
  const env = botToken ? { ...process.env, GH_TOKEN: botToken } : process.env;
  const { stdout } = await execFileAsync("gh", args, { env });
  return JSON.parse(stdout) as T;
}

/** Run gh without capturing output. Pass botToken to authenticate as the bot account. */
async function ghRun(args: string[], botToken?: string): Promise<void> {
  const env = botToken ? { ...process.env, GH_TOKEN: botToken } : process.env;
  await execFileAsync("gh", args, { env });
}

function getBotToken(id: RepoId): string | undefined {
  const repoCfg = loadRepoConfig(id);
  return repoCfg.githubToken || loadGlobalConfig().githubToken || undefined;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  user: string;
  state: string;
  htmlUrl: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  issueNumber: number;
  createdAt: string;
  htmlUrl: string;
}

export interface PRComment {
  id: number;
  body: string;
  user: string;
  prNumber: number;
  createdAt: string;
  htmlUrl: string;
  commentType: "issue" | "review";
  // Review comment fields (only present for inline code comments)
  path?: string;
  diffHunk?: string;
  line?: number;
}

export interface PullRequest {
  number: number;
  branch: string;
  merged: boolean;
  state: string;
  title: string;
  cloneUrl: string;
}

/**
 * Fetch all comments on a specific PR mentioning the bot.
 * Checks both PR discussion comments and inline review comments.
 */
export async function fetchPRComments(
  id: RepoId,
  prNumber: number,
  botTag: string
): Promise<PRComment[]> {
  const [issueComments, reviewComments] = await Promise.all([
    ghJson<any[]>(["api", `repos/${id.owner}/${id.repo}/issues/${prNumber}/comments?per_page=100`]),
    ghJson<any[]>(["api", `repos/${id.owner}/${id.repo}/pulls/${prNumber}/comments?per_page=100`]),
  ]);

  const comments: PRComment[] = [];

  for (const c of issueComments) {
    if (!c.body?.includes(botTag)) continue;
    comments.push({
      id: c.id,
      body: c.body,
      user: c.user?.login ?? "",
      prNumber,
      createdAt: c.created_at,
      htmlUrl: c.html_url ?? "",
      commentType: "issue",
    });
  }

  for (const c of reviewComments) {
    if (!c.body?.includes(botTag)) continue;
    comments.push({
      id: c.id,
      body: c.body,
      user: c.user?.login ?? "",
      prNumber,
      createdAt: c.created_at,
      htmlUrl: c.html_url ?? "",
      commentType: "review",
      path: c.path,
      diffHunk: c.diff_hunk,
      line: c.line ?? c.original_line,
    });
  }

  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return comments;
}

/**
 * Get PR details including branch and merge status.
 */
export async function getPullRequest(
  id: RepoId,
  prNumber: number
): Promise<PullRequest> {
  const data = await ghJson<any>([
    "pr", "view", String(prNumber),
    "--repo", `${id.owner}/${id.repo}`,
    "--json", "number,headRefName,mergedAt,state,title,headRepository",
  ]);

  const cloneUrl = data.headRepository?.url
    ? `${data.headRepository.url}.git`
    : `https://github.com/${id.owner}/${id.repo}.git`;

  return {
    number: data.number,
    branch: data.headRefName,
    merged: data.mergedAt != null,
    state: (data.state ?? "").toLowerCase(),
    title: data.title,
    cloneUrl,
  };
}

/**
 * Post a reply directly to an inline PR review comment.
 * Uses the configured bot token so the reply appears from the bot account.
 */
export async function postReviewCommentReply(
  id: RepoId,
  prNumber: number,
  replyToId: number,
  body: string
): Promise<number> {
  const data = await ghJson<any>([
    "api",
    `repos/${id.owner}/${id.repo}/pulls/${prNumber}/comments/${replyToId}/replies`,
    "--method", "POST",
    "-f", `body=${body}`,
  ], getBotToken(id));
  return data.id;
}

/**
 * Post a comment on a PR. Uses the configured bot token so the comment
 * appears from the bot account.
 */
export async function postComment(
  id: RepoId,
  prNumber: number,
  body: string
): Promise<number> {
  const data = await ghJson<any>([
    "api",
    `repos/${id.owner}/${id.repo}/issues/${prNumber}/comments`,
    "--method", "POST",
    "-f", `body=${body}`,
  ], getBotToken(id));
  return data.id;
}

/**
 * React to a comment (e.g., "eyes" to acknowledge). Uses the configured
 * bot token so the reaction appears from the bot account.
 * Failures are logged but not thrown — reactions are non-critical UX.
 */
export async function reactToComment(
  id: RepoId,
  commentId: number,
  reaction: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes",
  commentType: "issue" | "review" = "issue"
): Promise<void> {
  const endpoint = commentType === "review"
    ? `repos/${id.owner}/${id.repo}/pulls/comments/${commentId}/reactions`
    : `repos/${id.owner}/${id.repo}/issues/comments/${commentId}/reactions`;
  try {
    await ghRun(["api", endpoint, "--method", "POST", "-f", `content=${reaction}`], getBotToken(id));
  } catch (err: any) {
    console.warn(`[buffalo] Warning: could not react to comment ${commentId} (${err.message?.split("\n")[0]})`);
  }
}

/**
 * Get the default branch name for the repo.
 */
export async function getDefaultBranch(id: RepoId): Promise<string> {
  const data = await ghJson<any>([
    "api", `repos/${id.owner}/${id.repo}`,
  ], getBotToken(id));
  return data.default_branch ?? "main";
}

/**
 * List open issues (not PRs) for the repo.
 */
export async function listOpenIssues(id: RepoId): Promise<Issue[]> {
  const data = await ghJson<any[]>([
    "issue", "list",
    "--repo", `${id.owner}/${id.repo}`,
    "--state", "open",
    "--json", "number,title,body,author,url",
    "--limit", "100",
  ], getBotToken(id));

  return data.map((issue) => ({
    number: issue.number,
    title: issue.title ?? "",
    body: issue.body ?? "",
    user: issue.author?.login ?? "",
    state: "open",
    htmlUrl: issue.url ?? "",
  }));
}

/**
 * Fetch comments on a specific issue that mention the bot.
 */
export async function fetchIssueComments(
  id: RepoId,
  issueNumber: number,
  botTag: string
): Promise<IssueComment[]> {
  const data = await ghJson<any[]>([
    "api",
    `repos/${id.owner}/${id.repo}/issues/${issueNumber}/comments?per_page=100`,
  ], getBotToken(id));

  return data
    .filter((c) => c.body?.includes(botTag))
    .map((c) => ({
      id: c.id,
      body: c.body,
      user: c.user?.login ?? "",
      issueNumber,
      createdAt: c.created_at,
      htmlUrl: c.html_url ?? "",
    }));
}

/**
 * Create a pull request. Returns the PR number and URL.
 */
export async function createPullRequest(
  id: RepoId,
  branch: string,
  base: string,
  title: string,
  body: string
): Promise<{ number: number; url: string }> {
  const data = await ghJson<any>([
    "api",
    `repos/${id.owner}/${id.repo}/pulls`,
    "--method", "POST",
    "-f", `head=${branch}`,
    "-f", `base=${base}`,
    "-f", `title=${title}`,
    "-f", `body=${body}`,
  ], getBotToken(id));
  return { number: data.number, url: data.html_url };
}

/**
 * Delete a comment by ID. Uses the configured bot token.
 * Failures are logged but not thrown — deletion is best-effort cleanup.
 */
export async function deleteComment(
  id: RepoId,
  commentId: number,
  commentType: "issue" | "review" = "issue"
): Promise<void> {
  const endpoint = commentType === "review"
    ? `repos/${id.owner}/${id.repo}/pulls/comments/${commentId}`
    : `repos/${id.owner}/${id.repo}/issues/comments/${commentId}`;
  try {
    await ghRun(["api", endpoint, "--method", "DELETE"], getBotToken(id));
    console.log(`[buffalo] Deleted comment ${commentId}`);
  } catch (err: any) {
    console.warn(`[buffalo] Warning: could not delete comment ${commentId} (${err.message?.split("\n")[0]})`);
  }
}

/**
 * React to an issue body (not a comment).
 */
export async function reactToIssue(
  id: RepoId,
  issueNumber: number,
  reaction: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes"
): Promise<void> {
  try {
    await ghRun([
      "api",
      `repos/${id.owner}/${id.repo}/issues/${issueNumber}/reactions`,
      "--method", "POST",
      "-f", `content=${reaction}`,
    ], getBotToken(id));
  } catch (err: any) {
    console.warn(`[buffalo] Warning: could not react to issue ${issueNumber} (${err.message?.split("\n")[0]})`);
  }
}

/**
 * List open PRs for the repo.
 */
export async function listOpenPRs(id: RepoId): Promise<PullRequest[]> {
  const data = await ghJson<any[]>([
    "pr", "list",
    "--repo", `${id.owner}/${id.repo}`,
    "--state", "open",
    "--json", "number,headRefName,state,title,headRepository",
    "--limit", "100",
  ]);

  return data.map((pr) => ({
    number: pr.number,
    branch: pr.headRefName,
    merged: false,
    state: (pr.state ?? "").toLowerCase(),
    title: pr.title,
    cloneUrl: pr.headRepository?.url
      ? `${pr.headRepository.url}.git`
      : `https://github.com/${id.owner}/${id.repo}.git`,
  }));
}
