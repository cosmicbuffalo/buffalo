import * as fs from "node:fs";
import { type RepoId, loadRepoConfig, logFile } from "./config.js";
import { createWindow, runInWindow, pipeOutput, sendKeys, windowExists, ensureSession } from "./tmux-manager.js";
import { checkCommand, addRepoPattern } from "./command-guard.js";
import { appendHistory } from "./history.js";
import { getSession, setSession } from "./session-store.js";
import { postComment } from "./github.js";

// Patterns to detect in pipe-pane output
const APPROVAL_PATTERNS = [
  /Do you want to (run|execute)/i,
  /Allow this command/i,
  /\? \(y\/n\)/i,
  /Press Enter to approve/i,
  /permission to run/i,
  /wants to execute/i,
  /Allow .+ tool/i,
];

const COMPLETION_PATTERNS = [
  /\$\s*$/m,       // Shell prompt returned
  /❯\s*$/m,        // Zsh prompt
  />\s*$/m,         // Basic prompt
];

/**
 * Build the CLI command string for the chosen backend.
 */
function buildCliCommand(
  backend: "claude" | "codex",
  prompt: string,
  cwd: string
): string {
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  if (backend === "claude") {
    return `cd ${cwd} && claude --print '${escapedPrompt}'`;
  }
  return `cd ${cwd} && codex '${escapedPrompt}'`;
}

/**
 * Start a CLI session in a tmux window for a branch.
 */
export function startCliSession(
  id: RepoId,
  branch: string,
  prompt: string,
  cwd: string,
  prNumber: number
): void {
  const cfg = loadRepoConfig(id);

  ensureSession(id);
  createWindow(id, branch, cwd);
  pipeOutput(id, branch);

  const command = buildCliCommand(cfg.backend, prompt, cwd);
  runInWindow(id, branch, command);

  appendHistory(id, branch, {
    type: "cli_started",
    pr: prNumber,
    command,
    tmux_window: branch,
  });
}

/**
 * Monitor the pipe-pane log for a branch, looking for approval prompts or completion.
 * Returns when it detects something actionable.
 */
export async function monitorSession(
  id: RepoId,
  branch: string
): Promise<"completed" | "approval_needed" | "paused"> {
  const log = logFile(id, branch);
  const session = getSession(id, branch);
  if (!session) return "completed";
  if (session.status === "paused") return "paused";

  let offset = session.logOffset || 0;

  // Read new content from log
  if (!fs.existsSync(log)) return "completed";
  const content = fs.readFileSync(log, "utf-8");
  const newContent = content.slice(offset);
  offset = content.length;

  // Update offset
  session.logOffset = offset;
  setSession(id, branch, session);

  // Check for approval prompts
  for (const pattern of APPROVAL_PATTERNS) {
    if (pattern.test(newContent)) {
      // Extract the command being requested
      const cmdMatch = newContent.match(/[`"]([^`"]+)[`"]/);
      const command = cmdMatch ? cmdMatch[1] : "unknown command";

      const result = checkCommand(command, id);
      if (result.approved) {
        // Auto-approve
        sendKeys(id, branch, "y");
        appendHistory(id, branch, {
          type: "command_requested",
          pr: session.prNumber,
          command,
          approved: true,
          pattern: "auto-approved",
        });
      } else {
        // Escalate
        session.status = "waiting_approval";
        session.pendingApproval = {
          command,
          failedPart: result.failedPart ?? command,
        };
        setSession(id, branch, session);

        const commentId = await postComment(id, session.prNumber,
          `⚠️ **Command approval needed**\n\n` +
          `Buffalo wants to run:\n\`\`\`\n${command}\n\`\`\`\n\n` +
          `The part \`${result.failedPart}\` is not in the whitelist.\n\n` +
          `Reply with:\n` +
          `- \`@bot allow once\` — approve this one time\n` +
          `- \`@bot allow always <regex>\` — add a regex pattern to the whitelist\n` +
          `- \`@bot deny\` — reject this command`
        );

        session.pendingApproval.commentId = commentId;
        setSession(id, branch, session);

        appendHistory(id, branch, {
          type: "command_requested",
          pr: session.prNumber,
          command,
          approved: false,
          failedPart: result.failedPart,
        });

        return "approval_needed";
      }
    }
  }

  // Check if CLI seems done (window no longer exists or prompt returned)
  if (!windowExists(id, branch)) {
    return "completed";
  }

  return "completed";
}

/**
 * Handle an approval response from a PR comment.
 */
export function handleApproval(
  id: RepoId,
  branch: string,
  action: "allow_once" | "allow_always" | "deny",
  pattern?: string
): void {
  const session = getSession(id, branch);
  if (!session || !session.pendingApproval) return;

  if (action === "deny") {
    sendKeys(id, branch, "n");
    appendHistory(id, branch, {
      type: "command_denied",
      pr: session.prNumber,
      command: session.pendingApproval.command,
    });
  } else {
    sendKeys(id, branch, "y");
    appendHistory(id, branch, {
      type: "command_approved",
      pr: session.prNumber,
      command: session.pendingApproval.command,
      action,
    });

    if (action === "allow_always" && pattern) {
      addRepoPattern(id, pattern);
    }
  }

  session.status = "running";
  session.pendingApproval = undefined;
  setSession(id, branch, session);
}
