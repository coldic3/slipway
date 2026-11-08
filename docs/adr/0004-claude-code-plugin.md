# 0004. Claude Code plugin

Date: 2026-11-08 · Status: accepted

## Context
The whole loop (start a task, open a PR, fix the review, promote) should run from one agent session, with one install and no files
added to the user's repositories.

## Decision
- `plugin/` is a Claude Code plugin; the repository root is its marketplace (`.claude-plugin/marketplace.json`).
- A stdio MCP server exposes the `slipway_*` tools (status, start task, repo conventions, push, open and update PR, review comments,
  reply, promote). The agent still commits with git in the shell.
- Skills: `start-task`, `open-pr`, `fix-review`, `promote`. A `PreToolUse` hook guards GitHub writes (ADR 0009).
- The server and the hook are esbuild bundles in `plugin/dist/`, committed, because installed plugins are copied without
  `node_modules`. A test fails when the bundle is stale.
- On first use the server enrolls a Gitea user for this install (`claude-<hostname>`) with Slipway's technical admin (ADR 0005). It can
  push branches, open PRs and reply, but not approve or merge.
- The agent replies in review threads and never resolves them; the reviewer resolves a thread after checking the fix. "Unresolved" =
  review comments without a resolver from non-dismissed reviews.
- Each task gets its own worktree inside the project (`.slipway/worktrees/<id>-<slug>`, git-excluded) and its own branch (ADR 0010).

## Consequences
One install, nothing per repository. Plugin changes need `npm run build:plugin`, and users get them with `/plugin update`. The MCP
server is agent-neutral; skills and the hook are Claude Code specific.
