import { Octokit } from "@octokit/rest";
import { type RepoId, loadGlobalConfig, loadRepoConfig } from "./config.js";

function getOctokit(id: RepoId): Octokit {
  const repoCfg = loadRepoConfig(id);
  const token = repoCfg.githubToken || loadGlobalConfig().githubToken;
  return new Octokit({ auth: token });
}

export interface PRComment {
  id: number;
  body: string;
  user: string;
  prNumber: number;
  createdAt: string;
  htmlUrl: string;
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
 * Fetch issue comments since a given timestamp, filtering for @bot mentions.
 */
export async function fetchNewComments(
  id: RepoId,
  since: string,
  botTag: string
): Promise<PRComment[]> {
  const octokit = getOctokit(id);
  const comments: PRComment[] = [];

  const { data } = await octokit.issues.listCommentsForRepo({
    owner: id.owner,
    repo: id.repo,
    since,
    sort: "created",
    direction: "asc",
    per_page: 100,
  });

  for (const c of data) {
    if (!c.body?.includes(botTag)) continue;
    // Extract PR number from issue_url
    const prMatch = c.issue_url?.match(/\/issues\/(\d+)$/);
    if (!prMatch) continue;

    comments.push({
      id: c.id,
      body: c.body,
      user: c.user?.login ?? "",
      prNumber: parseInt(prMatch[1], 10),
      createdAt: c.created_at,
      htmlUrl: c.html_url ?? "",
    });
  }

  return comments;
}

/**
 * Get PR details including branch and merge status.
 */
export async function getPullRequest(
  id: RepoId,
  prNumber: number
): Promise<PullRequest> {
  const octokit = getOctokit(id);
  const { data } = await octokit.pulls.get({
    owner: id.owner,
    repo: id.repo,
    pull_number: prNumber,
  });

  return {
    number: data.number,
    branch: data.head.ref,
    merged: data.merged ?? false,
    state: data.state,
    title: data.title,
    cloneUrl: data.head.repo?.clone_url ?? `https://github.com/${id.owner}/${id.repo}.git`,
  };
}

/**
 * Post a comment on a PR.
 */
export async function postComment(
  id: RepoId,
  prNumber: number,
  body: string
): Promise<number> {
  const octokit = getOctokit(id);
  const { data } = await octokit.issues.createComment({
    owner: id.owner,
    repo: id.repo,
    issue_number: prNumber,
    body,
  });
  return data.id;
}

/**
 * React to a comment (e.g., "eyes" to acknowledge).
 */
export async function reactToComment(
  id: RepoId,
  commentId: number,
  reaction: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes"
): Promise<void> {
  const octokit = getOctokit(id);
  await octokit.reactions.createForIssueComment({
    owner: id.owner,
    repo: id.repo,
    comment_id: commentId,
    content: reaction,
  });
}

/**
 * List open PRs for the repo.
 */
export async function listOpenPRs(id: RepoId): Promise<PullRequest[]> {
  const octokit = getOctokit(id);
  const { data } = await octokit.pulls.list({
    owner: id.owner,
    repo: id.repo,
    state: "open",
    per_page: 100,
  });

  return data.map((pr) => ({
    number: pr.number,
    branch: pr.head.ref,
    merged: false,
    state: pr.state,
    title: pr.title,
    cloneUrl: pr.head.repo?.clone_url ?? `https://github.com/${id.owner}/${id.repo}.git`,
  }));
}
