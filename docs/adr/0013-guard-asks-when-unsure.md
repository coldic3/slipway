# 0013. The guard asks the user when Slipway cannot settle a write

Date: 2026-11-10 · Status: accepted · Amends [0009](0009-push-guard-hook.md)

## Context
ADR 0009 denied every guarded write that a promoted Slipway PR did not clear. With no way to say "yes, I want this", users and
agents hit dead ends: a hotfix on `main`, a tag, deleting a stale branch, merging a colleague's PR, a push to a non-GitHub remote.
Agents then worked around the hook, e.g. by writing a script for the user to run outside it. That habit makes the guard worthless:
the guard only sees Bash, so the work it is meant to catch moves to paths it never sees. The hook also read the command with
regexes and split on `;`, `|` and newlines inside quotes and heredocs. So text that merely mentioned `git push`, or the path of
Slipway's config, was treated as a command.

## Decision
- The hook returns one of three decisions. **allow**. **deny**: exit 2, the reason goes to Claude. **ask**: a PreToolUse
  `permissionDecision: "ask"`, so the user is prompted with the reason and decides.
- **Deny** only where Slipway has the proper path, and the habit it targets is the one to stop:
  - a branch with an open Slipway PR;
  - the session's own task branch (a Slipway worktree, `.slipway/worktrees/…`) with no Slipway PR yet;
  - promotion from the shell;
  - reading Slipway's credential files.
- **Ask** what Slipway cannot settle:
  - a branch without a Slipway PR that is not this task's (the main checkout, a colleague's PR, a branch from outside Slipway);
  - tags and pushes of many branches;
  - deleting a branch on GitHub (also for an open Slipway PR: deleting publishes no code);
  - a detached HEAD or an unknown PR head;
  - an unreachable Slipway.

  Asking replaces "fail closed" for these: the user is in the loop instead of a hard stop.
- **Push target**: only pushes to GitHub are guarded. That means the URL of `origin` (where promotion pushes), any URL that
  looks like GitHub (including SSH host aliases), or a URL that cannot be found. Pushes to the review Gitea or a deploy remote
  pass, and so does `--dry-run`.
- **Reading the shell**: a small reader (`src/mcp/shell.ts`) splits commands on operators outside quotes. It also:
  - keeps heredoc bodies as data;
  - drops redirections, comments, assignments and prefixes (`env`, `command`, `!`…);
  - reads into `sh -c '…'` and into heredocs fed to a shell (`bash <<'EOF'`);
  - skips quotes, parentheses and heredoc bodies inside `$(…)`, so a commit or PR body written through
    `"$(cat <<'EOF' … EOF)"` stays one word of data whatever quotes it holds.

  The credential check finds path-like runs ending in a credential file name inside words and redirection targets (also in
  `$(cat …)` or `require('…')`), resolves them (`~`, `$HOME`, relative to the cwd as moved by earlier `cd`s) and compares them
  with the real files, so a search pattern or a docs path does not match.
- The hook has a 60 s timeout in `hooks.json`; its own Gitea (5 s), `gh` and `git` calls are bounded below that.

## Consequences
- The core guard (the agent pushing its unreviewed task branch) is still a hard deny. Everything else the user decides, so
  agents have no reason to route around the hook.
- Claude Code does not document whether a hook's "ask" still prompts in `bypassPermissions` mode, or whether a settings allow rule
  overrides it. In those setups an asked write may go through without a prompt. Denied cases are unaffected: exit 2 blocks
  before permission rules apply.
- Under-blocking that stays accepted (ADR 0003): commands inside `$(…)` or backticks, other interpreters (`python -c`),
  and the Read tool are not inspected.
- A timed-out hook does not block (Claude Code's default for command hooks).
