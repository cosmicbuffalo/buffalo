import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHome, freshImport } from "./helpers.js";

describe("session-store", () => {
  let env: ReturnType<typeof createTestHome>;
  const repoId = { owner: "test", repo: "repo" };

  beforeEach(async () => {
    env = createTestHome();
    // Create repo dir
    const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");
    config.ensureDir(config.repoDir(repoId));
  });
  afterEach(() => env.cleanup());

  it("returns empty store when no file exists", async () => {
    const store = await freshImport<typeof import("../src/session-store.js")>(
      "../src/session-store.js"
    );
    const sessions = store.loadSessions(repoId);
    assert.deepEqual(sessions, { sessions: {} });
  });

  it("sets and gets a session", async () => {
    const store = await freshImport<typeof import("../src/session-store.js")>(
      "../src/session-store.js"
    );
    const info = {
      branch: "feature",
      prNumber: 42,
      commentIds: [1, 2],
      status: "running" as const,
      logOffset: 0,
    };
    store.setSession(repoId, "feature", info);
    const loaded = store.getSession(repoId, "feature");
    assert.deepEqual(loaded, info);
  });

  it("removes a session", async () => {
    const store = await freshImport<typeof import("../src/session-store.js")>(
      "../src/session-store.js"
    );
    store.setSession(repoId, "feature", {
      branch: "feature",
      prNumber: 42,
      commentIds: [],
      status: "running",
      logOffset: 0,
    });
    store.removeSession(repoId, "feature");
    assert.equal(store.getSession(repoId, "feature"), undefined);
  });

  it("pauses a running session", async () => {
    const store = await freshImport<typeof import("../src/session-store.js")>(
      "../src/session-store.js"
    );
    store.setSession(repoId, "feature", {
      branch: "feature",
      prNumber: 42,
      commentIds: [],
      status: "running",
      logOffset: 0,
    });
    const result = store.pauseSession(repoId, "feature");
    assert.equal(result, true);
    assert.equal(store.getSession(repoId, "feature")?.status, "paused");
  });

  it("pause returns false for non-existent session", async () => {
    const store = await freshImport<typeof import("../src/session-store.js")>(
      "../src/session-store.js"
    );
    assert.equal(store.pauseSession(repoId, "nope"), false);
  });

  it("resumes a paused session", async () => {
    const store = await freshImport<typeof import("../src/session-store.js")>(
      "../src/session-store.js"
    );
    store.setSession(repoId, "feature", {
      branch: "feature",
      prNumber: 42,
      commentIds: [],
      status: "paused",
      logOffset: 100,
    });
    const result = store.resumeSession(repoId, "feature");
    assert.equal(result, true);
    assert.equal(store.getSession(repoId, "feature")?.status, "running");
  });

  it("resume returns false for non-paused session", async () => {
    const store = await freshImport<typeof import("../src/session-store.js")>(
      "../src/session-store.js"
    );
    store.setSession(repoId, "feature", {
      branch: "feature",
      prNumber: 42,
      commentIds: [],
      status: "running",
      logOffset: 0,
    });
    assert.equal(store.resumeSession(repoId, "feature"), false);
  });

  it("saves and loads last poll timestamp", async () => {
    const store = await freshImport<typeof import("../src/session-store.js")>(
      "../src/session-store.js"
    );
    assert.equal(store.loadLastPoll(repoId), null);
    store.saveLastPoll(repoId, "2026-01-01T00:00:00Z");
    assert.equal(store.loadLastPoll(repoId), "2026-01-01T00:00:00Z");
  });

  it("preserves multiple sessions independently", async () => {
    const store = await freshImport<typeof import("../src/session-store.js")>(
      "../src/session-store.js"
    );
    store.setSession(repoId, "branch-a", {
      branch: "branch-a", prNumber: 1, commentIds: [], status: "running", logOffset: 0,
    });
    store.setSession(repoId, "branch-b", {
      branch: "branch-b", prNumber: 2, commentIds: [], status: "paused", logOffset: 50,
    });

    assert.equal(store.getSession(repoId, "branch-a")?.prNumber, 1);
    assert.equal(store.getSession(repoId, "branch-b")?.status, "paused");

    store.removeSession(repoId, "branch-a");
    assert.equal(store.getSession(repoId, "branch-a"), undefined);
    assert.equal(store.getSession(repoId, "branch-b")?.prNumber, 2);
  });
});
