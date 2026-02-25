import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTestHome, freshImport, writeJson } from "./helpers.js";

describe("config", () => {
  let env: ReturnType<typeof createTestHome>;

  beforeEach(() => {
    env = createTestHome();
  });
  afterEach(() => env.cleanup());

  it("buffaloDir returns path under HOME", async () => {
    const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");
    assert.equal(config.buffaloDir(), path.join(env.home, ".buffalo"));
  });

  it("repoDir returns correct nested path", async () => {
    const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");
    const id = { owner: "acme", repo: "widgets" };
    assert.equal(
      config.repoDir(id),
      path.join(env.buffaloDir, "repos", "acme", "widgets")
    );
  });

  it("workspaceDir includes branch", async () => {
    const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");
    const id = { owner: "acme", repo: "widgets" };
    const dir = config.workspaceDir(id, "feature-x");
    assert.ok(dir.endsWith("workspaces/feature-x"));
  });

  describe("global config", () => {
    it("returns defaults when no file exists", async () => {
      const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");
      const cfg = config.loadGlobalConfig();
      assert.equal(cfg.githubToken, "");
      assert.deepEqual(cfg.authorizedUsers, []);
      assert.equal(cfg.defaultBackend, "claude");
    });

    it("saves and loads global config", async () => {
      const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");
      const cfg = {
        githubToken: "ghp_test123",
        authorizedUsers: ["alice", "bob"],
        defaultBackend: "codex" as const,
        pollIntervalMs: 30000,
      };
      config.saveGlobalConfig(cfg);
      const loaded = config.loadGlobalConfig();
      assert.deepEqual(loaded, cfg);
    });
  });

  describe("repo config", () => {
    it("falls back to global defaults", async () => {
      const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");
      config.saveGlobalConfig({
        githubToken: "ghp_test",
        authorizedUsers: ["alice"],
        defaultBackend: "claude",
        pollIntervalMs: 60000,
      });
      const id = { owner: "acme", repo: "widgets" };
      // Save a minimal repo config with only botUsername; other fields fall back to global
      config.ensureDir(config.repoDir(id));
      config.saveRepoConfig(id, {
        botUsername: "acme-bot",
        authorizedUsers: [],
        backend: "claude",
        pollIntervalMs: 0,
      });
      // Overwrite with partial config to test fallback
      const fs = await import("node:fs");
      const path = await import("node:path");
      fs.writeFileSync(
        path.join(config.repoDir(id), "config.json"),
        JSON.stringify({ botUsername: "acme-bot" }) + "\n"
      );
      const repoCfg = config.loadRepoConfig(id);
      assert.equal(repoCfg.botUsername, "acme-bot");
      assert.deepEqual(repoCfg.authorizedUsers, ["alice"]);
      assert.equal(repoCfg.backend, "claude");
      assert.equal(repoCfg.pollIntervalMs, 60000);
    });

    it("repo config overrides global", async () => {
      const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");
      const id = { owner: "acme", repo: "widgets" };
      config.saveRepoConfig(id, {
        botUsername: "buffalo-bot",
        authorizedUsers: ["carol"],
        backend: "codex",
        pollIntervalMs: 5000,
        githubToken: "ghp_repo",
      });
      const repoCfg = config.loadRepoConfig(id);
      assert.equal(repoCfg.botUsername, "buffalo-bot");
      assert.deepEqual(repoCfg.authorizedUsers, ["carol"]);
      assert.equal(repoCfg.backend, "codex");
      assert.equal(repoCfg.githubToken, "ghp_repo");
    });
  });

  describe("whitelist", () => {
    it("returns empty array when no whitelist exists", async () => {
      const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");
      assert.deepEqual(config.loadWhitelist(), []);
    });

    it("saves and loads global whitelist", async () => {
      const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");
      config.saveGlobalWhitelist(["^ls\\b", "^cat\\b"]);
      assert.deepEqual(config.loadWhitelist(), ["^ls\\b", "^cat\\b"]);
    });

    it("merges global and repo whitelists", async () => {
      const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");
      config.saveGlobalWhitelist(["^ls\\b"]);
      const id = { owner: "acme", repo: "widgets" };
      config.saveRepoWhitelist(id, ["^docker\\b"]);
      const combined = config.loadWhitelist(id);
      assert.deepEqual(combined, ["^ls\\b", "^docker\\b"]);
    });
  });

  describe("initBuffaloDir", () => {
    it("creates directory and default whitelist", async () => {
      // Remove .buffalo to test fresh init
      fs.rmSync(env.buffaloDir, { recursive: true, force: true });
      const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");
      config.initBuffaloDir();
      assert.ok(fs.existsSync(env.buffaloDir));
      const wl = config.loadWhitelist();
      assert.ok(wl.length > 0);
      assert.ok(wl.includes("^ls\\b"));
    });

    it("does not overwrite existing whitelist", async () => {
      const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");
      config.saveGlobalWhitelist(["^custom\\b"]);
      config.initBuffaloDir();
      const wl = config.loadWhitelist();
      assert.deepEqual(wl, ["^custom\\b"]);
    });
  });

  describe("getAllRepos", () => {
    it("returns empty array when no repos exist", async () => {
      const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");
      assert.deepEqual(config.getAllRepos(), []);
    });

    it("finds configured repos", async () => {
      const config = await freshImport<typeof import("../src/config.js")>("../src/config.js");
      const id1 = { owner: "acme", repo: "widgets" };
      const id2 = { owner: "acme", repo: "gadgets" };
      config.saveRepoConfig(id1, {
        botUsername: "@bot",
        authorizedUsers: [],
        backend: "claude",
        pollIntervalMs: 60000,
      });
      config.saveRepoConfig(id2, {
        botUsername: "@bot",
        authorizedUsers: [],
        backend: "claude",
        pollIntervalMs: 60000,
      });
      const repos = config.getAllRepos();
      assert.equal(repos.length, 2);
      assert.ok(repos.some((r) => r.owner === "acme" && r.repo === "widgets"));
      assert.ok(repos.some((r) => r.owner === "acme" && r.repo === "gadgets"));
    });
  });
});
