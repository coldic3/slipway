import { git, run } from './exec.ts';

/**
 * Lease records kept in the user's clone: `refs/slipway/promoted/<branch>` (last SHA promoted to GitHub) and
 * `refs/slipway/pushed/<branch>` (last SHA pushed to Gitea).
 */
export function leaseRef(kind: 'promoted' | 'pushed', branch: string): string {
  return `refs/slipway/${kind}/${branch}`;
}

/** The recorded SHA, or '' when there is none. */
export async function readLease(repoDir: string, ref: string, env: NodeJS.ProcessEnv): Promise<string> {
  const res = await run('git', ['rev-parse', '-q', '--verify', ref], { cwd: repoDir, env });
  return res.code === 0 ? res.stdout.trim() : '';
}

export async function writeLease(repoDir: string, ref: string, sha: string, env: NodeJS.ProcessEnv): Promise<void> {
  await git(repoDir, ['update-ref', ref, sha], env);
}
