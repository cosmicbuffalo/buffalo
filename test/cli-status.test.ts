import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHome, nextImportId, writeJson } from "./helpers.js";

describe("cli status rendering", () => {
  let env: ReturnType<typeof createTestHome>;

  beforeEach(() => {
    env = createTestHome();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("shows a setup message when no repos are configured", async () => {
    const id = nextImportId();
    const cli = await import(`../src/cli.js?t=${id}`);
    const output = cli.renderStatusReport([], [], { color: false, now: Date.UTC(2026, 2, 20, 12, 0, 0) });
    assert.equal(output, "No repos configured. Run `buffalo init`.");
  });

  it("renders sessions with human-readable activity summaries", async () => {
    const id = nextImportId();
    const cli = await import(`../src/cli.js?t=${id}`);
    const history = await import(`../src/history.js?t=${id}`);

    const repo = { owner: "acme", repo: "widget" };
    const now = Date.UTC(2026, 2, 20, 12, 0, 0);

    history.appendHistory(repo, "feature/live-status", {
      type: "comment_detected",
      pr: 42,
      author: "alice",
      body: "@buffalo please tighten validation and add tests",
    });
    history.appendHistory(repo, "feature/needs-approval", {
      type: "command_requested",
      pr: 43,
      command: "docker build .",
      approved: false,
      failedPart: "docker build .",
    });

    const output = cli.renderStatusReport(
      [
        {
          id: repo,
          pid: 1234,
          isPolling: true,
          pollerState: {
            repo,
            intervalMs: 900000,
            failureCount: 0,
            nextPollAt: now + 5 * 60 * 1000,
          },
          sessions: {
            "feature/live-status": {
              branch: "feature/live-status",
              prNumber: 42,
              commentIds: [101],
              triggerComments: [
                {
                  user: "alice",
                  body: "Please tighten the validation around bad payloads and add tests for the new edge cases.",
                  commentId: 101,
                  commentType: "issue",
                },
              ],
              status: "running",
              logOffset: 0,
            },
            "feature/needs-approval": {
              branch: "feature/needs-approval",
              prNumber: 43,
              commentIds: [202],
              status: "waiting_approval",
              logOffset: 0,
              pendingApproval: {
                command: "docker build .",
                failedPart: "docker build .",
              },
            },
          },
        },
      ],
      [
        {
          ts: new Date(now - 2 * 60 * 1000).toISOString(),
          kind: "repo_poll_error",
          repo: "acme/widget",
          message: "GitHub API rate limit hit",
        },
      ],
      { color: false, now }
    );

    assert.match(output, /^Buffalo Status/m);
    assert.match(output, /Poller: RUNNING \(pid 1234\)/);
    assert.match(output, /Health: healthy; next poll in 5m/);
    assert.match(output, /feature\/live-status  PR #42  Running/);
    assert.match(output, /Current: new comment from @alice/);
    assert.match(output, /Request: @alice: Please tighten the validation around bad payloads and add tests for the new edge/);
    assert.match(output, /feature\/needs-approval  PR #43  Waiting For Approval/);
    assert.match(output, /Current: awaiting approval for `docker build \.`/);
    assert.match(output, /Recent Poller Errors/);
    assert.match(output, /remote\s+\|\s+time\s+\|\s+error\s+\|\s+message/);
    assert.match(output, /acme\/widget\s+\|\s+2m ago\s+\|\s+repo poll error\s+\|\s+GitHub API rate limit hit/);
    assert.doesNotMatch(output, /\u001b\[/);
  });

  it("renders extra detail for a targeted single repo view", async () => {
    const id = nextImportId();
    const cli = await import(`../src/cli.js?t=${id}`);
    const history = await import(`../src/history.js?t=${id}`);
    const config = await import(`../src/config.js?t=${id}`);

    const repo = { owner: "acme", repo: "widget" };
    const now = Date.UTC(2026, 2, 20, 12, 0, 0);

    config.saveRepoConfig(repo, {
      botUsername: "buffalo",
      authorizedUsers: ["alice"],
      backend: "codex",
      pollIntervalMs: 900000,
      githubToken: "ghp_test",
    });

    history.appendHistory(repo, "feature/needs-approval", {
      type: "comment_detected",
      pr: 43,
      author: "alice",
      body: "@buffalo please verify the docker image build",
    });
    history.appendHistory(repo, "feature/needs-approval", {
      type: "command_requested",
      pr: 43,
      command: "docker build .",
      approved: false,
      failedPart: "docker build .",
    });

    const output = cli.renderStatusReport(
      [
        {
          id: repo,
          pid: 999,
          isPolling: true,
          pollerState: {
            repo,
            intervalMs: 900000,
            failureCount: 1,
            nextPollAt: now + 90_000,
            lastError: "GitHub API timeout",
            lastErrorAt: now - 45_000,
          },
          sessions: {
            "feature/needs-approval": {
              branch: "feature/needs-approval",
              prNumber: 43,
              commentIds: [202],
              triggerComments: [
                {
                  user: "alice",
                  body: "Please verify the docker image build and post the result.",
                  commentId: 202,
                  commentType: "issue",
                },
              ],
              status: "waiting_approval",
              logOffset: 0,
              pendingApproval: {
                command: "docker build .",
                failedPart: "docker build .",
              },
            },
          },
        },
      ],
      [],
      { color: false, now, detailed: true }
    );

    assert.match(output, /Backend: codex/);
    assert.match(output, /Poll Interval: 15m/);
    assert.match(output, /Next Poll At:/);
    assert.match(output, /Approval Command: docker build \./);
    assert.match(output, /Recent Activity:/);
    assert.match(output, /approval requested for docker build \. \(just now\)|approval requested for docker build \./);
  });

  it("filters to the requested repo when dispatching status owner\/repo", async () => {
    const id = nextImportId();
    writeJson(`${env.buffaloDir}/repos/acme/widget/config.json`, {
      botUsername: "buffalo",
      authorizedUsers: ["alice"],
      backend: "codex",
      pollIntervalMs: 900000,
    });
    writeJson(`${env.buffaloDir}/repos/other/repo/config.json`, {
      botUsername: "buffalo",
      authorizedUsers: ["alice"],
      backend: "claude",
      pollIntervalMs: 900000,
    });
    writeJson(`${env.buffaloDir}/repos/acme/widget/sessions.json`, {
      sessions: {
        "feature/one": {
          branch: "feature/one",
          prNumber: 1,
          commentIds: [],
          status: "running",
          logOffset: 0,
        },
      },
    });
    writeJson(`${env.buffaloDir}/repos/other/repo/sessions.json`, {
      sessions: {
        "feature/two": {
          branch: "feature/two",
          prNumber: 2,
          commentIds: [],
          status: "paused",
          logOffset: 0,
        },
      },
    });

    const cli = await import(`../src/cli.js?t=${id}`);
    const origLog = console.log;
    const lines: string[] = [];
    console.log = (value?: unknown) => {
      lines.push(String(value ?? ""));
    };

    try {
      await cli.dispatch(["status", "acme/widget"]);
    } finally {
      console.log = origLog;
    }

    const output = lines.join("\n");
    assert.match(output, /acme\/widget/);
    assert.doesNotMatch(output, /other\/repo/);
    assert.match(output, /Backend: codex/);
    assert.match(output, /feature\/one  PR #1  Running/);
  });
});
