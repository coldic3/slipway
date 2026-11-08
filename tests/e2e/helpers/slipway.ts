import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { SlipwayConfig } from '../../../src/config.ts';
import { GiteaClient } from '../../../src/gitea/client.ts';
import { git, run, type ExecResult } from '../../../src/util/exec.ts';
import { E2E, e2eEnv, GITEA_URL, ROOT } from './env.ts';

export const AGENT_ID = { GIT_AUTHOR_NAME: 'Claude', GIT_AUTHOR_EMAIL: 'claude@slipway.local', GIT_COMMITTER_NAME: 'Claude', GIT_COMMITTER_EMAIL: 'claude@slipway.local' };

export function config(): SlipwayConfig {
  return JSON.parse(readFileSync(join(E2E.home, 'config.json'), 'utf8'));
}
export const reviewerApi = () => new GiteaClient(GITEA_URL, config().reviewer.token);
export const adminApi = () => new GiteaClient(GITEA_URL, config().admin.token);
export const claudeApi = () => new GiteaClient(GITEA_URL, config().claude!.token);

export function slipway(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<ExecResult> {
  return run(join(ROOT, 'bin', 'slipway'), args, { cwd: opts.cwd ?? ROOT, env: e2eEnv(opts.env), timeoutMs: 120_000 });
}

export async function slipwayOk(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<string> {
  const r = await slipway(args, opts);
  if (r.code !== 0) throw new Error(`slipway ${args.join(' ')} failed (${r.code}):\n${r.stderr}\n${r.stdout}`);
  return r.stdout;
}

/** Runs the plugin's bundled PreToolUse hook as Claude Code would for a Bash command; true when it blocks (exit 2). */
export async function hookBlocks(cwd: string, command: string): Promise<boolean> {
  const r = await run('node', [join(ROOT, 'plugin', 'dist', 'slipway-hook.mjs')], {
    env: e2eEnv(), input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }), timeoutMs: 30_000,
  });
  if (r.code !== 0 && r.code !== 2) throw new Error(`hook failed (${r.code}): ${r.stderr}`);
  return r.code === 2;
}

export interface RepoFixture { name: string; dir: string; origin: string }

/** A GitHub stand-in (bare origin) + Kevin's clone (with optional extra files), registered with `slipway repo add`. */
export async function makeRepo(name: string, files: Record<string, string> = {}): Promise<RepoFixture> {
  const base = join(E2E.repos, name);
  mkdirSync(base, { recursive: true });
  const env = e2eEnv();
  const origin = join(base, 'origin.git');
  const dir = join(base, name);
  await git(base, ['init', '-q', '--bare', '-b', 'main', origin], env);
  await git(base, ['clone', '-q', origin, dir], env);
  for (const [p, c] of Object.entries({ 'README.md': `# ${name}\n`, ...files })) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  await git(dir, ['add', '.'], env);
  await git(dir, ['commit', '-qm', 'Initial commit'], env);
  await git(dir, ['push', '-q', 'origin', 'main'], env);
  await slipwayOk(['repo', 'add', dir, '--name', name, '--github', `kevin/${name}`]);
  return { name, dir, origin };
}

/** What the start-task skill does: an isolated worktree on agent/<id>-<slug> with one commit. */
export async function claudeStartsTask(repo: RepoFixture, opts: { branch: string; file: string; content: string; message: string }): Promise<string> {
  const wt = join(E2E.repos, repo.name, `wt-${opts.branch.replace(/\W+/g, '-')}`);
  const env = e2eEnv(AGENT_ID);
  await git(repo.dir, ['fetch', '-q', 'origin'], env);
  await git(repo.dir, ['worktree', 'add', '-q', '-b', opts.branch, wt, 'origin/main'], env);
  await claudeCommits(wt, opts.file, opts.content, opts.message);
  return wt;
}

export async function claudeCommits(wt: string, file: string, content: string, message: string, fixupOf?: string): Promise<void> {
  const env = e2eEnv(AGENT_ID);
  writeFileSync(join(wt, file), content);
  await git(wt, ['add', file], env);
  await git(wt, fixupOf ? ['commit', '-q', `--fixup=${fixupOf}`] : ['commit', '-qm', message], env);
}

/** What fix-review does for the last commit: fold the change into it. */
export async function claudeAmends(wt: string, file: string, content: string): Promise<void> {
  const env = e2eEnv(AGENT_ID);
  writeFileSync(join(wt, file), content);
  await git(wt, ['add', file], env);
  await git(wt, ['commit', '-q', '--amend', '--no-edit'], env);
}

export async function claudeRebasesOnto(wt: string, upstream: string): Promise<void> {
  const env = e2eEnv(AGENT_ID);
  await git(wt, ['fetch', '-q', 'origin'], env);
  await git(wt, ['rebase', '-q', upstream], env);
}

/** Someone else's change lands on GitHub main (the bare origin). */
export async function humanPushesToGitHubMain(repo: RepoFixture, file: string, content: string, message: string): Promise<void> {
  const env = e2eEnv();
  await git(repo.dir, ['checkout', '-q', 'main'], env);
  writeFileSync(join(repo.dir, file), content);
  await git(repo.dir, ['add', file], env);
  await git(repo.dir, ['commit', '-qm', message], env);
  await git(repo.dir, ['push', '-q', 'origin', 'main'], env);
}

export async function prComments(repo: string, pr: number): Promise<string[]> {
  return (await reviewerApi().listComments(E2E.org, repo, pr)).map((c) => c.body);
}

export async function mockGitHub(): Promise<{ pulls: Array<{ head: string; base: string; title: string; body: string; draft: boolean; state: string; html_url: string }>; requests: Array<{ method: string; url: string; headers: Record<string, string> }> }> {
  const { mockUrl } = JSON.parse(readFileSync(E2E.stateFile, 'utf8'));
  return (await fetch(`${mockUrl}/__state`)).json();
}

export async function loginAsReviewer(page: Page): Promise<void> {
  await page.goto('/user/login');
  await page.getByLabel(/Username or Email/i).fill(E2E.reviewer);
  await page.getByLabel(/Password/i).fill(E2E.password);
  await page.getByRole('button', { name: /Sign In/i }).click();
  await expect(page).not.toHaveURL(/\/user\/login/);
}

/** Inline comment on a new-side line in the Files tab, starting (or adding to) a pending review. */
export async function addInlineComment(page: Page, repo: string, pr: number, line: number, text: string): Promise<void> {
  await page.goto(`/${E2E.org}/${repo}/pulls/${pr}/files`);
  const row = page.locator('tr', { has: page.locator(`td.lines-num-new[data-line-num="${line}"]`) }).first();
  await row.hover();
  await row.locator('button.add-code-comment-right').click();
  const form = page.locator('tr.add-comment form', { has: page.locator('textarea[name="content"]:visible') });
  await form.locator('textarea[name="content"]').fill(text);
  await form.getByRole('button', { name: 'Start review' }).click();
  await expect(page.getByText(text).first()).toBeVisible();
}

export async function submitReview(page: Page, repo: string, pr: number, verdict: 'Approve' | 'Request changes' | 'Comment', text = ''): Promise<void> {
  if (!page.url().includes(`/pulls/${pr}/files`)) await page.goto(`/${E2E.org}/${repo}/pulls/${pr}/files`);
  await page.getByRole('button', { name: /^Review/ }).first().click();
  if (text) await page.getByPlaceholder('Review comment').fill(text);
  await page.getByRole('button', { name: verdict, exact: true }).click();
  await page.waitForURL(new RegExp(`/pulls/${pr}(#.*)?$`));
}
