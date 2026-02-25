import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHome, freshImport } from "./helpers.js";

describe("history", () => {
  let env: ReturnType<typeof createTestHome>;
  const repoId = { owner: "test", repo: "repo" };

  beforeEach(() => {
    env = createTestHome();
  });
  afterEach(() => env.cleanup());

  it("returns empty array when no history exists", async () => {
    const history = await freshImport<typeof import("../src/history.js")>("../src/history.js");
    assert.deepEqual(history.readHistory(repoId, "feature"), []);
  });

  it("appends and reads events", async () => {
    const history = await freshImport<typeof import("../src/history.js")>("../src/history.js");

    history.appendHistory(repoId, "feature", {
      type: "comment_detected",
      pr: 42,
      author: "alice",
    });
    history.appendHistory(repoId, "feature", {
      type: "cli_started",
      pr: 42,
      command: "claude --print 'fix bug'",
    });

    const events = history.readHistory(repoId, "feature");
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "comment_detected");
    assert.equal(events[0].pr, 42);
    assert.equal(events[0].author, "alice");
    assert.equal(events[1].type, "cli_started");
    assert.ok(events[0].ts); // has timestamp
    assert.ok(events[1].ts);
  });

  it("keeps branches separate", async () => {
    const history = await freshImport<typeof import("../src/history.js")>("../src/history.js");

    history.appendHistory(repoId, "branch-a", { type: "event_a", pr: 1 });
    history.appendHistory(repoId, "branch-b", { type: "event_b", pr: 2 });

    assert.equal(history.readHistory(repoId, "branch-a").length, 1);
    assert.equal(history.readHistory(repoId, "branch-a")[0].type, "event_a");
    assert.equal(history.readHistory(repoId, "branch-b")[0].type, "event_b");
  });

  it("appends without overwriting", async () => {
    const history = await freshImport<typeof import("../src/history.js")>("../src/history.js");

    history.appendHistory(repoId, "append-test", { type: "first" });
    history.appendHistory(repoId, "append-test", { type: "second" });
    history.appendHistory(repoId, "append-test", { type: "third" });

    const events = history.readHistory(repoId, "append-test");
    assert.equal(events.length, 3);
    assert.equal(events[0].type, "first");
    assert.equal(events[2].type, "third");
  });

  it("generates valid ISO timestamps", async () => {
    const history = await freshImport<typeof import("../src/history.js")>("../src/history.js");
    history.appendHistory(repoId, "feature", { type: "test" });
    const events = history.readHistory(repoId, "feature");
    const ts = new Date(events[0].ts);
    assert.ok(!isNaN(ts.getTime()));
  });
});
