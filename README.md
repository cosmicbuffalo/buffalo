# Buffalo

A self-hosted GitHub PR collaborator bot. Buffalo polls your repos for `@buffalo` comments on pull requests, clones the relevant branch, runs a CLI agent (Claude Code or Codex CLI) inside a tmux window, commits and pushes the result, and replies on the PR.

Every CLI session runs in its own tmux window. You can attach at any time to watch, take over, or debug. A regex-based command whitelist controls what the agent is allowed to run — anything else gets escalated to humans via a PR comment.

## Why

Code review bots that run in opaque containers give you no visibility and no escape hatch. Buffalo runs locally (or on your own server), in tmux, where you can see exactly what's happening and intervene when needed. It's a human-in-the-loop system that happens to automate the boring parts.

## Install

**From npm:**

```bash
npm install -g buffalo
```

**From source:**

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/buffalo/main/install.sh | sh
```

Requires **Node >= 22** and **tmux**.

## Setting Up a Bot Account

Buffalo works best with a dedicated GitHub account that acts as the bot. This keeps bot activity separate from your personal account and makes it obvious which comments and commits came from automation.

1. **Create a new GitHub account** (e.g. `my-buffalo-bot`). Use a separate email address.
2. **Generate a Personal Access Token** on the bot account:
   - Go to Settings > Developer settings > Personal access tokens > Fine-grained tokens
   - Create a token scoped to the repos Buffalo will operate on
   - Required permissions: **Read and Write** access to **Contents**, **Issues**, and **Pull requests**
3. **Add the bot as a collaborator** on each repo (Settings > Collaborators). It needs write access to push commits and post comments.
4. **Run `buffalo init`** and paste the bot account's token when prompted.

The bot account's username is what appears on commits and PR comments. Authorized users (configured during `buffalo init`) are the *human* accounts allowed to command the bot — the bot account itself doesn't need to be in that list.

> **Tip:** If you're just trying Buffalo out, you can skip the dedicated account and use your own PAT. You can always switch to a bot account later by updating `~/.buffalo/repos/<owner>/<repo>/config.json`.

## Quick Start

```bash
cd your-repo
buffalo init       # walks you through setup
buffalo start      # begins polling for @buffalo comments
```

`buffalo init` will ask for:

1. A GitHub Personal Access Token (use a dedicated bot account)
2. A bot mention tag (default: `@buffalo`)
3. Which GitHub users are authorized to command the bot
4. Which CLI backend to use (`claude` or `codex`)

Once running, any authorized user can comment `@buffalo fix the typo in README.md` on a PR and Buffalo will:

1. Clone the PR's branch
2. Open a tmux window and run the CLI agent with the request
3. Auto-approve whitelisted commands, escalate everything else
4. Commit and push the changes
5. Reply on the PR with what it did

## Commands

### Lifecycle

```bash
buffalo init          # Set up a repo (interactive)
buffalo start         # Start polling (current repo, or all repos if outside a repo)
buffalo stop          # Stop polling
buffalo status        # Show all repos, active sessions, pause state
```

### Session Management

Commands auto-detect the current branch via `git rev-parse` when no branch is specified.

```bash
buffalo attach                    # Attach to tmux window for current branch
buffalo attach feature-branch     # Attach to a specific branch's window
buffalo attach --repo owner/repo  # Attach to a repo's tmux session

buffalo pause                     # Pause bot on current branch (CLI keeps running)
buffalo pause feature-branch      # Pause a specific branch
buffalo resume                    # Resume processing
buffalo resume feature-branch
```

### Observability

```bash
buffalo list                      # List all active tmux windows across all repos
buffalo logs                      # Tail pipe-pane log for current branch
buffalo logs feature-branch       # Tail a specific branch's log
buffalo history                   # Show action history for current branch
buffalo history feature-branch    # Show action history for a specific branch
```

### Whitelist Management

```bash
buffalo whitelist                 # Show current whitelist (global + repo)
buffalo whitelist add "^docker\b" # Add a regex pattern
buffalo whitelist remove 3        # Remove pattern by index
```

## Command Approval

Buffalo enforces a regex-based whitelist on every command the CLI agent wants to run. Compound commands (`&&`, `||`, `;`, `|`, `$()`, backticks) are split apart and each piece is checked independently.

**Default safe patterns** (pre-populated on init):

- Read-only: `git status/diff/log/show/branch`, `ls`, `cat`, `head`, `tail`, `find`, `grep`, `wc`, `echo`
- Build/test: `npm test/run/install`, `node`, `npx`, `python`, `pip install`
- File ops: `sed`, `awk`, `mkdir`, `touch`, `cp`, `mv`

When a command isn't whitelisted, Buffalo posts a PR comment:

> **Command approval needed**
>
> Buffalo wants to run:
> ```
> docker build -t myapp .
> ```
> The part `docker build -t myapp .` is not in the whitelist.
>
> Reply with:
> - `@buffalo allow once` — approve this one time
> - `@buffalo allow always ^docker\b` — add a regex pattern to the whitelist
> - `@buffalo deny` — reject this command

## How It Works

### Polling

Buffalo polls `GET /repos/{owner}/{repo}/issues/comments?since={last_check}` every 15 minutes (configurable). Only comments from authorized users that mention the bot tag are processed. It also checks whether tracked PRs have been merged or closed, and cleans up accordingly.

### tmux Layout

One tmux session per repo, one window per branch:

```
tmux session: "buffalo-owner-repo"
  ├── window: "feature-branch"      ← running claude CLI
  ├── window: "fix-bug"             ← running codex CLI
  └── window: "refactor-api"        ← completed, output captured
```

Output is captured via `tmux pipe-pane` to log files that Buffalo monitors for approval prompts and completion signals.

### Pause / Resume

`buffalo pause` sets a flag — Buffalo stops reading the log for that window, but the CLI keeps running in tmux. You can attach, interact freely, then `buffalo resume` to hand control back. This is useful when the agent gets stuck and you want to manually fix something before letting it continue.

### Batching

Multiple `@buffalo` comments on the same PR within a poll cycle are batched into a single prompt. The CLI agent sees all requests at once and addresses them together.

## Directory Structure

```
~/.buffalo/
  config.json                          # Global config
  whitelist.json                       # Global command whitelist
  repos/
    owner/
      repo/
        config.json                    # Per-repo overrides
        whitelist.json                 # Per-repo whitelist additions
        sessions.json                  # Active session state
        last_poll.json                 # Last poll timestamp
        workspaces/
          feature-branch/              # Cloned branch worktree
        logs/
          feature-branch.log           # Pipe-pane output
        history/
          feature-branch.jsonl         # Action audit trail
```

### Action History

Every action Buffalo takes is logged as a JSONL event in `history/<branch>.jsonl`:

```jsonl
{"ts":"2026-02-25T10:15:00Z","type":"comment_detected","pr":123,"author":"user1","body":"@buffalo fix the typo"}
{"ts":"2026-02-25T10:15:05Z","type":"cli_started","pr":123,"command":"claude --print ..."}
{"ts":"2026-02-25T10:16:30Z","type":"command_requested","pr":123,"command":"sed -i 's/teh/the/' README.md","approved":true}
{"ts":"2026-02-25T10:17:00Z","type":"commit_pushed","pr":123,"sha":"abc123"}
{"ts":"2026-02-25T10:17:05Z","type":"comment_posted","pr":123}
{"ts":"2026-02-25T12:00:00Z","type":"pr_merged","pr":123}
{"ts":"2026-02-25T12:00:01Z","type":"cleanup","pr":123,"tmux_window_destroyed":true}
```

History files persist after cleanup so you always have an audit trail.

## Configuration

### Global (`~/.buffalo/config.json`)

```json
{
  "githubToken": "ghp_...",
  "authorizedUsers": ["alice", "bob"],
  "defaultBackend": "claude",
  "pollIntervalMs": 900000
}
```

### Per-repo (`~/.buffalo/repos/owner/repo/config.json`)

```json
{
  "botTag": "@buffalo",
  "authorizedUsers": ["alice"],
  "backend": "codex",
  "pollIntervalMs": 300000,
  "githubToken": "ghp_repo_specific_token"
}
```

Per-repo config overrides global. Whitelists are merged (global + repo).

## Development

```bash
git clone <repo-url>
cd buffalo
npm install
npm run build
npm test          # 80 tests across 8 test files
```

Tests use Node's built-in test runner, temp directories for filesystem isolation, real tmux sessions for integration tests, and local bare git repos for clone/push verification. No mocking frameworks — just the standard library.

## License

MIT
