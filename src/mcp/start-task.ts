import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, run } from '../util/exec.ts';

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const WORKTREES_DIR = join('.slipway', 'worktrees');

/** Adds a pattern to .git/info/exclude (local ignore, nothing committed). */
export function ensureExcluded(repoDir: string, pattern: string): void {
  const file = join(repoDir, '.git', 'info', 'exclude');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.split('\n').includes(pattern)) return;
  mkdirSync(join(repoDir, '.git', 'info'), { recursive: true });
  appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`);
}

/** Branch used when the repository has no branch-naming rule (ADR 0010). */
export const defaultBranch = (taskId: string, slug: string) => `agent/${taskId}-${slug}`;

/** Refuses names git would reject and the base branch itself (work never happens on the base). */
async function checkBranchName(repoDir: string, branch: string, base: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (branch === base) throw new Error(`branch must not be the base branch (${base}): pick a task branch name`);
  const r = await run('git', ['check-ref-format', '--branch', branch], { cwd: repoDir, env });
  if (r.code !== 0) throw new Error(`"${branch}" is not a valid git branch name`);
}

/**
 * Creates the task's worktree INSIDE the project (`.slipway/worktrees/<id>-<slug>`, git-excluded) from a fresh
 * `origin/<base>`, on `branch` (the name the repository's conventions ask for) or `agent/<id>-<slug>`. Inside the
 * project, Claude Code keeps it as the shell's cwd and allows edits without extra prompts. An existing task worktree
 * is reused on whatever branch it has.
 */
export async function startTaskWorktree(o: { repoDir: string; base: string; taskId: string; slug: string; branch?: string; env?: NodeJS.ProcessEnv }): Promise<{ path: string; branch: string; existed: boolean }> {
  if (!SAFE.test(o.taskId)) throw new Error('task_id may contain only letters, digits, ".", "_" and "-"');
  if (!SAFE.test(o.slug)) throw new Error('slug may contain only letters, digits, ".", "_" and "-" (use kebab-case)');
  const env = o.env ?? process.env;
  const path = join(o.repoDir, WORKTREES_DIR, `${o.taskId}-${o.slug}`);
  ensureExcluded(o.repoDir, '/.slipway/');
  if (existsSync(path)) return { path, branch: await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'], env), existed: true };
  const branch = o.branch?.trim() || defaultBranch(o.taskId, o.slug);
  await checkBranchName(o.repoDir, branch, o.base, env);
  await git(o.repoDir, ['fetch', '--quiet', 'origin', o.base], env);
  const exists = (await run('git', ['rev-parse', '-q', '--verify', `refs/heads/${branch}`], { cwd: o.repoDir, env })).code === 0;
  await git(o.repoDir, exists ? ['worktree', 'add', '--quiet', path, branch] : ['worktree', 'add', '--quiet', '-b', branch, path, `origin/${o.base}`], env);
  return { path, branch, existed: false };
}
