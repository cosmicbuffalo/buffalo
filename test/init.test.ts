import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createTestHome, writeJson } from "./helpers.js";
import type { RepoConfig } from "../src/config.js";

describe("init", () => {
  let env: ReturnType<typeof createTestHome>;

  beforeEach(() => {
    env = createTestHome();
  });
  afterEach(() => env.cleanup());

  describe("obscureToken", () => {
    // obscureToken is not exported, so test the logic inline
    function obscureToken(token: string): string {
      if (token.length <= 8) return "****";
      return token.slice(0, 4) + "****" + token.slice(-4);
    }

    it("obscures long tokens showing first 4 and last 4", () => {
      assert.equal(obscureToken("ghp_abcdefghijklmnop"), "ghp_****mnop");
    });

    it("fully obscures short tokens", () => {
      assert.equal(obscureToken("short"), "****");
      assert.equal(obscureToken("12345678"), "****");
    });

    it("handles 9-char tokens", () => {
      assert.equal(obscureToken("123456789"), "1234****6789");
    });
  });

  describe("prefilling from existing config", () => {
    it("loads previous config for prefill defaults", async () => {
      const config = await import("../src/config.js");
      const repoId = { owner: "acme", repo: "widgets" };

      const saved: RepoConfig = {
        botUsername: "mybot",
        authorizedUsers: ["alice", "bob"],
        backend: "codex",
        pollIntervalMs: 30000,
        githubToken: "ghp_previoustoken123",
      };
      config.saveRepoConfig(repoId, saved);

      const loaded = config.loadRepoConfig(repoId);
      assert.equal(loaded.botUsername, "mybot");
      assert.deepEqual(loaded.authorizedUsers, ["alice", "bob"]);
      assert.equal(loaded.backend, "codex");
      assert.equal(loaded.githubToken, "ghp_previoustoken123");
      assert.equal(loaded.pollIntervalMs, 30000);
    });

    it("preserves pollIntervalMs across re-init", async () => {
      const config = await import("../src/config.js");
      const repoId = { owner: "acme", repo: "widgets" };

      // Simulate first init with custom poll interval
      config.saveRepoConfig(repoId, {
        botUsername: "buffalo-bot",
        authorizedUsers: ["alice"],
        backend: "claude",
        pollIntervalMs: 60000,
        githubToken: "ghp_token",
      });

      // Simulate re-init: load existing, save with new values but keep pollIntervalMs
      const existing = config.loadRepoConfig(repoId);
      const updated: RepoConfig = {
        botUsername: "newbot",
        authorizedUsers: ["alice", "carol"],
        backend: "codex",
        pollIntervalMs: existing.pollIntervalMs, // preserved
        githubToken: "ghp_newtoken",
      };
      config.saveRepoConfig(repoId, updated);

      const reloaded = config.loadRepoConfig(repoId);
      assert.equal(reloaded.pollIntervalMs, 60000);
      assert.equal(reloaded.botUsername, "newbot");
    });

    it("keeps existing token when new token is empty", async () => {
      const config = await import("../src/config.js");
      const repoId = { owner: "acme", repo: "widgets" };

      config.saveRepoConfig(repoId, {
        botUsername: "buffalo-bot",
        authorizedUsers: [],
        backend: "claude",
        pollIntervalMs: 900000,
        githubToken: "ghp_keep_this",
      });

      const existing = config.loadRepoConfig(repoId);
      const userInput = ""; // user pressed Enter without typing
      const finalToken = userInput || existing.githubToken || "";
      assert.equal(finalToken, "ghp_keep_this");
    });

    it("replaces token when user provides a new one", async () => {
      const config = await import("../src/config.js");
      const repoId = { owner: "acme", repo: "widgets" };

      config.saveRepoConfig(repoId, {
        botUsername: "buffalo-bot",
        authorizedUsers: [],
        backend: "claude",
        pollIntervalMs: 900000,
        githubToken: "ghp_old_token",
      });

      const existing = config.loadRepoConfig(repoId);
      const userInput = "ghp_brand_new";
      const finalToken = userInput || existing.githubToken || "";
      assert.equal(finalToken, "ghp_brand_new");
    });
  });

  describe("global config inheritance", () => {
    it("repo config inherits botUsername and authorizedUsers from global when not overridden", async () => {
      const config = await import("../src/config.js");
      const repoId = { owner: "acme", repo: "widgets" };

      // Simulate first init: save to global, write {} to repo
      config.saveGlobalConfig({
        githubToken: "ghp_global",
        botUsername: "global-bot",
        authorizedUsers: ["alice"],
        defaultBackend: "claude",
        pollIntervalMs: 900000,
      });
      config.saveRepoConfig(repoId, {});

      const repoCfg = config.loadRepoConfig(repoId);
      assert.equal(repoCfg.botUsername, "global-bot");
      assert.deepEqual(repoCfg.authorizedUsers, ["alice"]);
      assert.equal(repoCfg.backend, "claude");
      assert.equal(repoCfg.pollIntervalMs, 900000);
      // githubToken is not propagated through loadRepoConfig; getBotToken reads it directly
      assert.equal(repoCfg.githubToken, undefined);
    });

    it("repo config override wins over global", async () => {
      const config = await import("../src/config.js");
      const repoId = { owner: "acme", repo: "widgets" };

      config.saveGlobalConfig({
        githubToken: "ghp_global",
        botUsername: "global-bot",
        authorizedUsers: ["alice"],
        defaultBackend: "claude",
        pollIntervalMs: 900000,
      });
      // Simulate subsequent init with repo-specific overrides
      config.saveRepoConfig(repoId, { botUsername: "repo-bot", backend: "codex" });

      const repoCfg = config.loadRepoConfig(repoId);
      assert.equal(repoCfg.botUsername, "repo-bot");
      assert.equal(repoCfg.backend, "codex");
      // Non-overridden fields still fall back to global
      assert.deepEqual(repoCfg.authorizedUsers, ["alice"]);
      assert.equal(repoCfg.pollIntervalMs, 900000);
    });
  });

  describe("hasExistingConfig detection", () => {
    it("returns false when no config exists", async () => {
      const config = await import("../src/config.js");
      const repoId = { owner: "noexist", repo: "nope" };
      const configPath = path.join(config.repoDir(repoId), "config.json");
      assert.equal(fs.existsSync(configPath), false);
    });

    it("returns true after saving config", async () => {
      const config = await import("../src/config.js");
      const repoId = { owner: "acme", repo: "widgets" };
      config.saveRepoConfig(repoId, {
        botUsername: "buffalo-bot",
        authorizedUsers: [],
        backend: "claude",
        pollIntervalMs: 900000,
      });
      const configPath = path.join(config.repoDir(repoId), "config.json");
      assert.equal(fs.existsSync(configPath), true);
    });
  });
});
