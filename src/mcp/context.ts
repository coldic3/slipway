import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SlipwayConfig, RepoEntry } from '../config.ts';
import { run } from '../util/exec.ts';

export class NotRegisteredError extends Error {
  constructor(where: string, sandbox?: string) {
    super(sandbox
      ? `${where} is not a Slipway repo. Ask the user to run on the host: slipway repo add <path-to-the-clone>, then slipway sbx setup ${sandbox}`
      : `${where} is not a Slipway repo. Ask the user to run: slipway repo add <path-to-the-clone>`);
  }
}

export interface RepoContext {
  /** Name of the repo in Slipway/Gitea. */
  name: string;
  entry: RepoEntry;
  /** Top of the working tree the session is in (the clone or one of its worktrees). */
  worktree: string;
  /** Current branch, null on detached HEAD. */
  branch: string | null;
}

const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));

/** Finds the registered repo for a directory: the clone itself or any `git worktree` of it. */
export async function resolveRepo(cwd: string, config: SlipwayConfig): Promise<RepoContext> {
  const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (top.code !== 0) throw new NotRegisteredError(cwd, config.sandbox);
  const common = (await run('git', ['rev-parse', '--git-common-dir'], { cwd })).stdout.trim();
  const mainClone = real(dirname(resolve(cwd, common)));
  const found = Object.entries(config.repos).find(([, r]) => real(r.path) === mainClone);
  if (!found) throw new NotRegisteredError(mainClone, config.sandbox);
  const head = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout.trim();
  return { name: found[0], entry: found[1], worktree: top.stdout.trim(), branch: head && head !== 'HEAD' ? head : null };
}
