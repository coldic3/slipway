import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { VERSION } from '../version.ts';
import { openPr, promoteTool, startTask, push, reply, repoConventions, reviewComments, status, updatePr, type ToolResult } from './tools.ts';

const cwd = z.string().optional().describe('Absolute path of your current working directory (the clone or the git worktree you work in). Always pass it.');
const pr = z.number().int().positive().optional().describe('Slipway PR number; defaults to the open PR of the current branch.');

const asContent = (r: ToolResult) => ({ content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) });

export function createServer(): McpServer {
  const server = new McpServer({ name: 'slipway', version: VERSION });

  server.registerTool('slipway_status', {
    description: 'Slipway state for the current repo: Gitea, your Gitea user, branch, and the PR of this branch (state: in-review / changes-requested / approved / closed, unresolved comments). Enrolls this Claude in Gitea on first use.',
    inputSchema: { cwd },
  }, async (a) => asContent(await status(a)));

  server.registerTool('slipway_start_task', {
    description: "Start a task: creates (or reuses) a git worktree inside the project at .slipway/worktrees/<task_id>-<slug> from the fresh base, on `branch` or, when the repo has no branch naming rule, agent/<task_id>-<slug>. Check slipway_repo_conventions first. cd into the returned path and pass it as cwd afterwards.",
    inputSchema: {
      cwd,
      task_id: z.string().min(1).describe('Ticket/issue id, e.g. 123 or DRY-12'),
      slug: z.string().min(1).describe('kebab-case summary, e.g. add-login'),
      branch: z.string().min(1).optional().describe("Branch name following the repo's naming rules, e.g. feature/DRY-12-add-login. Omit when the repo has none."),
    },
  }, async (a) => asContent(await startTask(a)));

  server.registerTool('slipway_repo_conventions', {
    description: "The repository's own rules for branch names, PR titles and descriptions (PR templates, CONTRIBUTING, CLAUDE.md/AGENTS.md, commitlint, PR-title and branch-name CI checks, git hooks), or Slipway's default template. Call before starting a task and before writing or fixing a PR title/description.",
    inputSchema: { cwd },
  }, async (a) => asContent(await repoConventions(a)));

  server.registerTool('slipway_push', {
    description: 'Push the current branch (HEAD) to the local Slipway Gitea. Never pushes to GitHub. Use force_with_lease=true after rewriting history (amend, autosquash, rebase); it refuses to overwrite commits you have not seen.',
    inputSchema: { cwd, force_with_lease: z.boolean().optional() },
  }, async (a) => asContent(await push(a)));

  server.registerTool('slipway_open_pr', {
    description: 'Push the current branch and open a Slipway PR (or return the existing one). Title and body must follow slipway_repo_conventions.',
    inputSchema: { cwd, title: z.string().min(1), body: z.string(), base: z.string().optional() },
  }, async (a) => asContent(await openPr(a)));

  server.registerTool('slipway_update_pr', {
    description: "Change the PR title and/or description. Refused once the user approved the PR (then only the user edits it).",
    inputSchema: { cwd, pr, title: z.string().min(1).optional(), body: z.string().optional() },
  }, async (a) => asContent(await updatePr(a)));

  server.registerTool('slipway_review_comments', {
    description: 'Unresolved review feedback on the PR: the latest review summary and each open inline thread (comment_id, file:line, text, diff context).',
    inputSchema: { cwd, pr },
  }, async (a) => asContent(await reviewComments(a)));

  server.registerTool('slipway_reply', {
    description: 'Reply in a review thread (what you changed, or why not). Never resolves the thread; the user does.',
    inputSchema: { cwd, pr, comment_id: z.number().int().positive(), body: z.string().min(1) },
  }, async (a) => asContent(await reply(a)));

  server.registerTool('slipway_promote', {
    description: 'Promote the approved PR to GitHub exactly as reviewed: same commits (no rebase, no squashing), secret scan, optional tests, push, open or update the GitHub PR with the exact Gitea title/description. Only works when the user approved the current commit and the branch contains the current base.',
    inputSchema: {
      cwd, pr,
      draft: z.boolean().optional(),
      base: z.string().optional().describe('GitHub target branch (default: the repo base)'),
      test_cmd: z.string().optional().describe('Command to run on the rebased branch before pushing, e.g. "npm test"'),
    },
  }, async (a) => asContent(await promoteTool(a)));

  return server;
}

export async function startServer(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
