import * as path from "node:path";
import {
  type RepoId,
  detectRepoFromCwd,
  initBuffaloDir,
  repoDir,
  ensureDir,
  saveRepoConfig,
  type RepoConfig,
  logDir,
  historyDir,
} from "./config.js";

export async function runInit(): Promise<void> {
  const inquirer = await import("inquirer");
  const prompt = inquirer.default.prompt ?? inquirer.default;

  initBuffaloDir();

  console.log("\n🦬 Buffalo — GitHub PR Collaborator Bot\n");

  // Detect repo
  const detected = detectRepoFromCwd();
  let repoId: RepoId;

  if (detected) {
    console.log(`Detected repo: ${detected.owner}/${detected.repo}`);
    const { confirm } = await prompt([
      { type: "confirm", name: "confirm", message: "Use this repo?", default: true },
    ]);
    if (confirm) {
      repoId = detected;
    } else {
      const { owner, repo } = await prompt([
        { type: "input", name: "owner", message: "GitHub owner:" },
        { type: "input", name: "repo", message: "GitHub repo:" },
      ]);
      repoId = { owner, repo };
    }
  } else {
    console.log("Could not detect repo from git remote.");
    const { owner, repo } = await prompt([
      { type: "input", name: "owner", message: "GitHub owner:" },
      { type: "input", name: "repo", message: "GitHub repo:" },
    ]);
    repoId = { owner, repo };
  }

  // GitHub PAT
  const { token } = await prompt([
    {
      type: "password",
      name: "token",
      message: "GitHub Personal Access Token (for bot account):",
      mask: "*",
    },
  ]);

  // Bot tag
  const { botTag } = await prompt([
    {
      type: "input",
      name: "botTag",
      message: "Bot mention tag:",
      default: "@buffalo",
    },
  ]);

  // Authorized users
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

  // CLI backend
  const { backend } = await prompt([
    {
      type: "list",
      name: "backend",
      message: "CLI backend:",
      choices: ["claude", "codex"],
      default: "claude",
    },
  ]);

  // Save config
  const cfg: RepoConfig = {
    botTag,
    authorizedUsers,
    backend,
    pollIntervalMs: 15 * 60 * 1000,
    githubToken: token,
  };

  const rd = repoDir(repoId);
  ensureDir(rd);
  ensureDir(path.join(rd, "workspaces"));
  ensureDir(logDir(repoId));
  ensureDir(historyDir(repoId));

  saveRepoConfig(repoId, cfg);

  console.log(`\n✅ Buffalo configured for ${repoId.owner}/${repoId.repo}`);
  console.log(`   Config: ${rd}/config.json`);
  console.log(`\nRemember to add the bot user as a collaborator on the repo.`);
  console.log(`Run \`buffalo start\` to begin polling.\n`);
}
