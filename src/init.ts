import * as path from "node:path";
import * as fs from "node:fs";
import {
  type RepoId,
  type RemoteInfo,
  detectAllRemotes,
  initBuffaloDir,
  repoDir,
  ensureDir,
  saveRepoConfig,
  loadRepoConfig,
  type RepoConfig,
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

export async function runInit(): Promise<void> {
  const inquirer = await import("inquirer");
  const prompt = inquirer.default.prompt ?? inquirer.default;

  initBuffaloDir();

  console.log("\n🦬 Buffalo — GitHub PR Collaborator Bot\n");

  // Detect remotes
  const remotes = detectAllRemotes();
  let selectedRepos: RepoId[] = [];

  if (remotes.length > 1) {
    // Multiple remotes — let the user pick
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
    // Manual entry
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

  // Configure each selected repo
  for (const repoId of selectedRepos) {
    console.log(`\n--- Configuring ${repoId.owner}/${repoId.repo} ---\n`);

    // Load existing config for prefilling
    const existing = hasExistingConfig(repoId)
      ? loadRepoConfig(repoId)
      : null;

    // GitHub PAT
    const tokenMessage = existing?.githubToken
      ? `GitHub PAT (current: ${obscureToken(existing.githubToken)}, press Enter to keep):`
      : "GitHub Personal Access Token (for bot account):";
    const { token } = await prompt([
      {
        type: "password",
        name: "token",
        message: tokenMessage,
        mask: "*",
      },
    ]);
    const finalToken = token || existing?.githubToken || "";

    // Bot username
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
        default: existing?.botUsername ?? undefined,
        validate: (v: string) => {
          if (!v.trim()) return "A bot username is required.";
          if (v.startsWith("@")) return "Enter the username without the @ prefix.";
          return true;
        },
      },
    ]);

    // Authorized users
    const existingUsers = existing?.authorizedUsers?.join(", ") ?? "";
    const { usersStr } = await prompt([
      {
        type: "input",
        name: "usersStr",
        message: "Authorized GitHub usernames (comma-separated):",
        default: existingUsers || undefined,
      },
    ]);
    const authorizedUsers = usersStr
      .split(",")
      .map((u: string) => u.trim())
      .filter(Boolean);

    // CLI backend
    const { backend } = await prompt([
      {
        type: "list",
        name: "backend",
        message: "CLI backend:",
        choices: ["claude", "codex"],
        default: existing?.backend ?? "claude",
      },
    ]);

    // Save config
    const cfg: RepoConfig = {
      botUsername: botUsername.trim(),
      authorizedUsers,
      backend,
      pollIntervalMs: existing?.pollIntervalMs ?? 15 * 60 * 1000,
      githubToken: finalToken,
    };

    const rd = repoDir(repoId);
    ensureDir(rd);
    ensureDir(path.join(rd, "workspaces"));
    ensureDir(logDir(repoId));
    ensureDir(historyDir(repoId));

    saveRepoConfig(repoId, cfg);

    console.log(`✅ Configured ${repoId.owner}/${repoId.repo}`);
    console.log(`   Config: ${rd}/config.json`);
  }

  console.log(`\nRemember to add the bot user as a collaborator on each repo.`);
  console.log(`Run \`buffalo start\` to begin polling in the background.\n`);
}
