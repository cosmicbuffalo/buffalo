import * as path from "node:path";
import * as fs from "node:fs";
import {
  type RepoId,
  type RemoteInfo,
  detectAllRemotes,
  initBuffaloDir,
  buffaloDir,
  repoDir,
  ensureDir,
  saveRepoConfig,
  saveGlobalConfig,
  loadGlobalConfig,
  loadRepoConfig,
  logDir,
  historyDir,
} from "./config.js";

function obscureToken(token: string): string {
  if (token.length <= 8) return "****";
  return token.slice(0, 4) + "****" + token.slice(-4);
}

function hasExistingConfig(id: RepoId): boolean {
  return fs.existsSync(path.join(repoDir(id), "config.json"));
}

function setupRepoDirs(id: RepoId): void {
  const rd = repoDir(id);
  ensureDir(rd);
  ensureDir(path.join(rd, "workspaces"));
  ensureDir(logDir(id));
  ensureDir(historyDir(id));
}

export async function runInit(): Promise<void> {
  const inquirer = await import("inquirer");
  const prompt = inquirer.default.prompt ?? inquirer.default;

  initBuffaloDir();

  console.log("\n🦬 Buffalo — GitHub PR Collaborator Bot\n");

  // Detect remotes
  const remotes = detectAllRemotes();
  let selectedRepos: RepoId[] = [];

  if (remotes.length > 1) {
    const choices = remotes.map((r) => {
      const existing = hasExistingConfig(r);
      return {
        name: `${r.remoteName} → ${r.owner}/${r.repo}${existing ? " (configured)" : ""}`,
        value: r,
        checked: existing,
      };
    });

    const { selected } = await prompt([
      {
        type: "checkbox",
        name: "selected",
        message: "Which remotes should Buffalo be active on?",
        choices,
        validate: (answer: RemoteInfo[]) =>
          answer.length > 0 || "Select at least one remote.",
      },
    ]);
    selectedRepos = selected.map((r: RemoteInfo) => ({
      owner: r.owner,
      repo: r.repo,
    }));
  } else if (remotes.length === 1) {
    const r = remotes[0];
    console.log(`Detected repo: ${r.owner}/${r.repo} (${r.remoteName})`);
    const { confirm } = await prompt([
      {
        type: "confirm",
        name: "confirm",
        message: "Use this repo?",
        default: true,
      },
    ]);
    if (confirm) {
      selectedRepos = [{ owner: r.owner, repo: r.repo }];
    }
  }

  if (selectedRepos.length === 0) {
    console.log(
      remotes.length === 0
        ? "Could not detect any git remotes."
        : "No remote selected."
    );
    const { owner, repo } = await prompt([
      { type: "input", name: "owner", message: "GitHub owner:" },
      { type: "input", name: "repo", message: "GitHub repo:" },
    ]);
    selectedRepos = [{ owner, repo }];
  }

  const globalCfgPath = path.join(buffaloDir(), "config.json");
  const isFirstInit = !fs.existsSync(globalCfgPath);
  const globalCfg = loadGlobalConfig();

  if (isFirstInit) {
    // ── First-time setup: collect and save global defaults ─────────────────
    console.log(
      "First-time setup — answers will be saved as global defaults for all repos.\n"
    );

    const { token } = await prompt([
      {
        type: "password",
        name: "token",
        message: "GitHub Personal Access Token (for bot account):",
        mask: "*",
      },
    ]);

    console.log(
      "\n  Buffalo works by monitoring PR comments that @mention a dedicated\n" +
        "  GitHub bot account. Enter the GitHub username of the bot account\n" +
        "  that will be used to run Buffalo (e.g. \"my-buffalo-bot\").\n" +
        "  Comments tagging @<username> on PRs will trigger the bot.\n"
    );
    const { botUsername } = await prompt([
      {
        type: "input",
        name: "botUsername",
        message: "Bot account GitHub username (without @):",
        validate: (v: string) => {
          if (!v.trim()) return "A bot username is required.";
          if (v.startsWith("@")) return "Enter the username without the @ prefix.";
          return true;
        },
      },
    ]);

    const { usersStr } = await prompt([
      {
        type: "input",
        name: "usersStr",
        message: "Authorized GitHub usernames (comma-separated):",
      },
    ]);
    const authorizedUsers = usersStr
      .split(",")
      .map((u: string) => u.trim())
      .filter(Boolean);

    const { backend } = await prompt([
      {
        type: "list",
        name: "backend",
        message: "CLI backend:",
        choices: ["claude", "codex"],
        default: "claude",
      },
    ]);

    saveGlobalConfig({
      githubToken: token,
      botUsername: botUsername.trim(),
      authorizedUsers,
      defaultBackend: backend,
      pollIntervalMs: 15 * 60 * 1000,
    });

    console.log("\n✅ Global config saved.\n");

    for (const id of selectedRepos) {
      setupRepoDirs(id);
      saveRepoConfig(id, {});
      console.log(`✅ Configured ${id.owner}/${id.repo}`);
      console.log(`   Config: ${repoDir(id)}/config.json`);
    }
  } else {
    // ── Subsequent init: per-repo with global pre-fill ──────────────────────
    console.log(
      `Global config loaded (bot: @${globalCfg.botUsername || "(not set)"})\n` +
        `Showing global defaults — press Enter to accept, or type a new value to override for this repo.\n`
    );

    for (const id of selectedRepos) {
      console.log(`\n--- Configuring ${id.owner}/${id.repo} ---\n`);

      // Effective values: global merged with any existing repo overrides
      const effective = loadRepoConfig(id);

      // GitHub PAT
      const tokenCurrent = effective.githubToken ?? globalCfg.githubToken;
      const tokenMsg = tokenCurrent
        ? `GitHub PAT (current: ${obscureToken(tokenCurrent)}, press Enter to keep):`
        : "GitHub Personal Access Token (leave blank to use global):";
      const { token } = await prompt([
        { type: "password", name: "token", message: tokenMsg, mask: "*" },
      ]);
      const finalToken = token || tokenCurrent || "";

      // Bot username
      const { botUsername } = await prompt([
        {
          type: "input",
          name: "botUsername",
          message: "Bot account GitHub username (without @):",
          default: effective.botUsername || undefined,
          validate: (v: string) => {
            if (!v.trim()) return "A bot username is required.";
            if (v.startsWith("@")) return "Enter the username without the @ prefix.";
            return true;
          },
        },
      ]);

      // Authorized users
      const { usersStr } = await prompt([
        {
          type: "input",
          name: "usersStr",
          message: "Authorized GitHub usernames (comma-separated):",
          default: effective.authorizedUsers?.join(", ") || undefined,
        },
      ]);
      const authorizedUsers = usersStr
        .split(",")
        .map((u: string) => u.trim())
        .filter(Boolean);

      // Backend
      const { backend } = await prompt([
        {
          type: "list",
          name: "backend",
          message: "CLI backend:",
          choices: ["claude", "codex"],
          default: effective.backend ?? globalCfg.defaultBackend ?? "claude",
        },
      ]);

      // Build overrides: only save values that differ from global
      const overrides: Partial<ReturnType<typeof loadRepoConfig>> = {};

      if (finalToken && finalToken !== globalCfg.githubToken) {
        overrides.githubToken = finalToken;
      }
      const trimmedBot = botUsername.trim();
      if (trimmedBot !== globalCfg.botUsername) {
        overrides.botUsername = trimmedBot;
      }
      const authSorted = [...authorizedUsers].sort().join(",");
      const globalAuthSorted = [...(globalCfg.authorizedUsers ?? [])].sort().join(",");
      if (authSorted !== globalAuthSorted) {
        overrides.authorizedUsers = authorizedUsers;
      }
      if (backend !== globalCfg.defaultBackend) {
        overrides.backend = backend;
      }

      setupRepoDirs(id);
      saveRepoConfig(id, overrides);

      const overrideKeys = Object.keys(overrides);
      if (overrideKeys.length > 0) {
        console.log(
          `✅ Configured ${id.owner}/${id.repo} (repo overrides: ${overrideKeys.join(", ")})`
        );
      } else {
        console.log(`✅ Configured ${id.owner}/${id.repo} (using global defaults)`);
      }
      console.log(`   Config: ${repoDir(id)}/config.json`);
    }
  }

  console.log(`\nRemember to add the bot user as a collaborator on each repo.`);
  console.log(`Run \`buffalo start\` to begin polling in the background.\n`);
}
