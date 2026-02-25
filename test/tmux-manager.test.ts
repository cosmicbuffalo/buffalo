import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHome, freshImport } from "./helpers.js";

describe("tmux-manager", () => {
  let env: ReturnType<typeof createTestHome>;
  const repoId = { owner: "test", repo: "repo" };

  beforeEach(() => {
    env = createTestHome();
  });
  afterEach(() => env.cleanup());

  it("listWindows returns empty array when no tmux sessions", async () => {
    const tmux = await freshImport<typeof import("../src/tmux-manager.js")>(
      "../src/tmux-manager.js"
    );
    const windows = tmux.listWindows();
    // If tmux is not running, should return empty
    const buffaloWindows = windows.filter((w) => w.session.startsWith("buffalo-test-"));
    assert.deepEqual(buffaloWindows, []);
  });

  it("windowExists returns false for nonexistent window", async () => {
    const tmux = await freshImport<typeof import("../src/tmux-manager.js")>(
      "../src/tmux-manager.js"
    );
    assert.equal(tmux.windowExists(repoId, "nonexistent"), false);
  });

  it("can create and destroy tmux sessions", async () => {
    const tmux = await freshImport<typeof import("../src/tmux-manager.js")>(
      "../src/tmux-manager.js"
    );

    // Create session
    tmux.ensureSession(repoId);

    // Create window
    tmux.createWindow(repoId, "test-branch", "/tmp");
    assert.equal(tmux.windowExists(repoId, "test-branch"), true);

    // Destroy window
    tmux.destroyWindow(repoId, "test-branch");
    assert.equal(tmux.windowExists(repoId, "test-branch"), false);

    // Clean up session
    tmux.destroySession(repoId);
  });

  it("ensureSession is idempotent", async () => {
    const tmux = await freshImport<typeof import("../src/tmux-manager.js")>(
      "../src/tmux-manager.js"
    );
    tmux.ensureSession(repoId);
    tmux.ensureSession(repoId); // Should not throw
    tmux.destroySession(repoId);
  });

  it("createWindow is idempotent", async () => {
    const tmux = await freshImport<typeof import("../src/tmux-manager.js")>(
      "../src/tmux-manager.js"
    );
    tmux.ensureSession(repoId);
    tmux.createWindow(repoId, "branch", "/tmp");
    tmux.createWindow(repoId, "branch", "/tmp"); // Should not create duplicate
    assert.equal(tmux.windowExists(repoId, "branch"), true);
    tmux.destroySession(repoId);
  });

  it("pipeOutput creates log file directory", async () => {
    const tmux = await freshImport<typeof import("../src/tmux-manager.js")>(
      "../src/tmux-manager.js"
    );
    const fs = await import("node:fs");
    const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");

    tmux.ensureSession(repoId);
    tmux.createWindow(repoId, "log-test", "/tmp");
    tmux.pipeOutput(repoId, "log-test");

    // Log dir should exist
    assert.ok(fs.existsSync(config.logDir(repoId)));

    tmux.destroySession(repoId);
  });

  it("listWindows includes buffalo sessions", async () => {
    const tmux = await freshImport<typeof import("../src/tmux-manager.js")>(
      "../src/tmux-manager.js"
    );
    tmux.ensureSession(repoId);
    tmux.createWindow(repoId, "my-branch", "/tmp");

    const windows = tmux.listWindows();
    const found = windows.find(
      (w) => w.session === "buffalo-test-repo" && w.window === "my-branch"
    );
    assert.ok(found, "Should find buffalo window in list");

    tmux.destroySession(repoId);
  });
});
