import * as fs from "node:fs";
import * as path from "node:path";
import { type RepoId, loadRepoConfig, logFile, logDir, lastMessageFile, ensureDir } from "./config.js";
import { createWindow, runInWindow, pipeOutput, sendKeys, windowExists, ensureSession, destroyWindow } from "./tmux-manager.js";
import { checkCommand, addRepoPattern } from "./command-guard.js";
import { appendHistory } from "./history.js";
import { getSession, setSession, shouldResumeBranch } from "./session-store.js";
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

// Startup prompts that should always be auto-answered with "1" (Yes/Continue)
const STARTUP_PATTERNS = [
  /Do you trust the contents of this directory/i,
];

// How long (ms) with no new log output before we consider the CLI idle/waiting
const IDLE_TIMEOUT_MS = 90_000;

/** Strip ANSI/VT escape sequences and carriage returns from terminal output. */
function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")          // CSI sequences (colors, cursor moves)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences (title, hyperlinks)
    .replace(/\x1b./g, "")                              // Other 2-char escapes
    .replace(/\r/g, "");                                // Carriage returns
}

/**
 * Extract the last meaningful block of output from a raw terminal log.
 * Returns up to the last 50 non-empty lines, capped at 3000 chars.
 */
function extractLastOutput(rawLog: string): string {
  const lines = stripAnsi(rawLog)
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  const joined = lines.slice(-50).join("\n");
  const MAX = 3000;
  return joined.length > MAX ? `…\n${joined.slice(-MAX)}` : joined;
}

export interface SessionOutput {
  response: string | null;
  tokensUsed: number | null;
}

/**
 * Parse the token count from a terminal log.
 * Codex outputs "tokens used\n86,864" (split across two lines) or inline.
 * Returns the LAST occurrence — codex logs intermediate counts too, and the
 * final one (after all tool calls) is the accurate total.
 */
function parseTokensFromTerminalLog(rawLog: string): number | null {
  const lines = stripAnsi(rawLog).split("\n");
  let last: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    // Two-line format: "tokens used" on one line, number on the next
    if (/^tokens\s+used\s*$/i.test(lines[i].trim())) {
      const num = lines[i + 1]?.trim().match(/^([\d,]+)$/);
      if (num) last = parseInt(num[1].replace(/,/g, ""), 10);
    }
    // Single-line format: "tokens used: 86,864" or "tokens used 86,864"
    const inline = lines[i].match(/tokens?\s+used[:\s]+([\d,]+)/i);
    if (inline) last = parseInt(inline[1].replace(/,/g, ""), 10);
  }
  return last;
}

/**
 * Strip trailing shell-prompt lines from the end of cleaned terminal output.
 * Handles zsh/bash prompts and common prompt-theme decorators.
 */
function stripTrailingPrompt(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1].trim();
    if (
      line === "" ||
      /^[%$>❯]\s*$/.test(line) ||           // bare prompt character
      /^[%$>❯]\s/.test(line) ||              // prompt with text after it
      /^[±✗✓]\s/.test(line) ||              // git/status prefix chars
      /\bin\s+(~\/|\/home\/|\/Users\/)/.test(line) || // "in ~/some/path"
      /\bon\s+\S+\s+\[/.test(line)           // "on branch-name [status]"
    ) {
      end--;
    } else {
      break;
    }
  }
  return lines.slice(0, end);
}

/**
 * Read the session response and token count for a branch.
 *
 * For fresh codex runs: reads from --output-last-message file (clean markdown).
 * Fallback (resume mode or if file missing): extracts from terminal log.
 * Token count always comes from the terminal log (last occurrence).
 */
export function readSessionOutput(id: RepoId, branch: string): SessionOutput {
  // Token count always from the terminal log (last occurrence = accurate total)
  const log = logFile(id, branch);
  const rawLog = fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "";
  const tokensUsed = rawLog ? parseTokensFromTerminalLog(rawLog) : null;

  // Prefer the clean --output-last-message file written by codex
  const msgFile = lastMessageFile(id, branch);
  if (fs.existsSync(msgFile)) {
    const response = fs.readFileSync(msgFile, "utf-8").trim() || null;
    return { response, tokensUsed };
  }

  // Fallback: extract from terminal log.
  // Codex emits all tool-call output (diffs, commit info, etc.) first, then
  // "tokens used\nNNN" as a separator, then its final text response.
  // Split on the last such marker so we skip the noisy tool-call section.
  if (!rawLog) return { response: null, tokensUsed };
  const lines = stripAnsi(rawLog).split("\n").map((l) => l.trimEnd());

  let splitAfter = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^tokens\s+used\s*$/i.test(lines[i].trim())) {
      const num = lines[i + 1]?.trim().match(/^([\d,]+)$/);
      if (num) splitAfter = i + 1; // index of the number line
    }
  }

  const responseLines = splitAfter >= 0 ? lines.slice(splitAfter + 1) : lines.slice(-50);
  const stripped = stripTrailingPrompt(responseLines).filter((l) => l.trim().length > 0);
  const response = stripped.join("\n") || null;
  return { response, tokensUsed };
}

/**
 * Write the prompt and a wrapper script to disk, returning the script path.
 * Using a script file avoids all shell quoting issues — the prompt is read
 * from a file via $(cat), never embedded in a shell string.
 */
function writeCliScript(
  id: RepoId,
  branch: string,
  backend: "claude" | "codex",
  prompt: string,
  cwd: string,
  resume: boolean
): string {
  ensureDir(logDir(id));
  const base = path.join(logDir(id), branch);
  const promptFile = `${base}-prompt.txt`;
  const scriptFile = `${base}-run.sh`;

  fs.writeFileSync(promptFile, prompt, "utf-8");

  // Use stdin redirect — avoids all shell quoting issues with arbitrary prompt content.
  // codex exec: non-interactive mode, `-` reads prompt from stdin.
  // claude --print: reads prompt from stdin when no argument given.
  // For fresh codex runs, --output-last-message saves the agent's final text
  // response to a file — clean markdown without any tool-call output noise.
  // Resume mode doesn't support this flag so it falls back to terminal log parsing.
  const lastMsgFile = lastMessageFile(id, branch);
  // Remove any stale file from a previous session so readSessionOutput won't
  // return old content if --output-last-message fails to write a new one.
  try { fs.unlinkSync(lastMsgFile); } catch { /* doesn't exist — fine */ }

  let tool: string;
  if (backend === "claude") {
    tool = `claude --print`;
  } else if (resume) {
    tool = `codex exec resume --last --full-auto -`;
  } else {
    tool = `codex exec --sandbox workspace-write --output-last-message '${lastMsgFile}' -`;
  }
  const script = [
    "#!/bin/bash",
    `cd '${cwd}'`,
    `${tool} < '${promptFile}'`,
    // Kill the window when done so the poller detects completion via windowExists
    `tmux kill-window`,
  ].join("\n");

  fs.writeFileSync(scriptFile, script, "utf-8");
  fs.chmodSync(scriptFile, 0o755);

  return scriptFile;
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

  // Resume the codex session when the previous session left an unresolved thread
  // (i.e. it replied but didn't push a commit). Always start fresh for claude.
  const resume = cfg.backend === "codex" && shouldResumeBranch(id, branch);
  if (resume) {
    console.log(`[buffalo] Resuming codex session for ${branch} (previous thread unresolved)`);
  }

  ensureSession(id);
  createWindow(id, branch, cwd);
  pipeOutput(id, branch);

  const scriptFile = writeCliScript(id, branch, cfg.backend, prompt, cwd, resume);
  const command = `bash ${scriptFile}`;
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
): Promise<"completed" | "running" | "approval_needed" | "paused"> {
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

  // Auto-answer startup prompts (e.g. codex "do you trust this directory?")
  for (const pattern of STARTUP_PATTERNS) {
    if (pattern.test(newContent)) {
      sendKeys(id, branch, "1");
    }
  }

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

  // Session is done only when its tmux window is gone
  if (!windowExists(id, branch)) {
    return "completed";
  }

  // If no meaningful new output since last check, see if the log has gone idle.
  // This handles the case where codex/claude finishes its task but remains open
  // waiting for more user input — kill the window so the poller can wrap up.
  if (!stripAnsi(newContent).trim()) {
    try {
      const stat = fs.statSync(log);
      const idleMs = Date.now() - stat.mtimeMs;
      if (idleMs >= IDLE_TIMEOUT_MS) {
        console.log(
          `[buffalo] Session ${branch} idle for ${Math.round(idleMs / 1000)}s — closing window`
        );
        destroyWindow(id, branch);
        return "completed";
      }
    } catch {
      // ignore stat errors
    }
  }

  return "running";
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
