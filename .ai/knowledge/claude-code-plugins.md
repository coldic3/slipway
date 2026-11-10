# Claude Code plugin knowledge (Claude Code 2.1.319, verified 2026-11-07)

- Layout: `plugin/.claude-plugin/plugin.json` (name, description, version, author), `plugin/.mcp.json`
  (`{"mcpServers": {"slipway": {"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/…"]}}}`),
  `plugin/hooks/hooks.json`, and `plugin/skills/<name>/SKILL.md` (frontmatter `name` + `description`).
- Marketplace: `<repo>/.claude-plugin/marketplace.json` → `{"name", "owner": {"name"}, "plugins": [{"name", "source": "./plugin", "description"}]}`.
  Install: `/plugin marketplace add <path>` then `/plugin install <plugin>@<marketplace>`.
- `claude plugin validate <dir>` validates a plugin or marketplace (exit 0 = ok); used in `tests/functional/plugin.test.ts`.
- Installed plugins are copied to `~/.claude/plugins/cache/...` without `node_modules`, so ship bundled JS (esbuild, ESM, with a
  `createRequire` banner for CJS deps).
- PreToolUse hook: JSON on stdin (`tool_name`, `tool_input.command`, `cwd`); exit code 2 blocks and stderr goes back to Claude.
- To prompt the user instead (docs: code.claude.com/docs/en/hooks, checked 2026-11-10): exit 0 and print
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"…"}}`; the reason is
  shown in the permission prompt (Claude reads it only in `-p` runs). Exit 2 wins over any JSON and blocks before permission rules.
  Multiple hooks: deny > defer > ask > allow. Auto mode still prompts for a hook "ask". Not documented: "ask" under
  `bypassPermissions`/`acceptEdits`, and "ask" vs. a settings allow rule.
- Hook `timeout` in `hooks.json` is in seconds (command hooks default to 600); a timed-out hook does not block unless
  `"onFailure": "block"`.
- Our hook asks Gitea (`/pulls?state=all`, matched on `head.ref`) per guarded command: closed → allow, open → deny, none → deny on
  the task branch, else ask (ADR 0009, 0013). The functional plugin test has no Gitea, so it exercises the ask path (`slipway up`).
- MCP SDK 1.32: `new McpServer({name, version}).registerTool(name, {description, inputSchema: {zod raw shape}}, handler)`; zod 4 works.
  Test clients: `Client` + `StdioClientTransport({command, args, cwd, env})`.
- Gitea admin API for enrollment: `POST /admin/users` {username, email, password, must_change_password:false} (422 if it exists),
  `PATCH /admin/users/{u}` {login_name, source_id: 0, password} to reset.
