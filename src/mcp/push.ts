import { git, run } from '../util/exec.ts';
import { leaseRef, readLease, writeLease } from '../util/lease-refs.ts';

export interface PushOptions {
  /** Working tree to push from (clone or worktree). */
  worktree: string;
  /** Main clone (keeps refs/slipway/pushed/<branch>). */
  repoDir: string;
  /** Gitea clone URL and per-command auth. */
  url: string;
  authArgs: string[];
  base: string;
  branch: string | null;
  force: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Pushes HEAD to the same branch on Gitea. Refuses detached HEAD and the base branch. Force (after amend/autosquash/rebase)
 * leases on the SHA this tool pushed last, so commits someone else pushed are never overwritten.
 */
export async function pushBranch(o: PushOptions): Promise<{ ok: boolean; message: string }> {
  if (!o.branch) return { ok: false, message: 'Detached HEAD: check out your task branch first.' };
  if (o.branch === o.base) return { ok: false, message: `Refusing to push ${o.base}: work on a task branch (slipway_start_task).` };
  const env = o.env ?? process.env;
  const record = leaseRef('pushed', o.branch);
  const args = [...o.authArgs, '-c', 'credential.helper=', 'push', '--quiet'];
  if (o.force) {
    let expected = await readLease(o.repoDir, record, env);
    if (!expected) {
      // No record (branch reached Gitea some other way): lease on the current Gitea tip, but only if this clone
      // already knows that commit, i.e. Claude has seen it. A tip we never saw is someone else's work.
      const remote = await run('git', [...o.authArgs, '-c', 'credential.helper=', 'ls-remote', o.url, `refs/heads/${o.branch}`], { cwd: o.worktree, env });
      const tip = remote.stdout.trim().split(/\s+/)[0] ?? '';
      if (tip) {
        const known = await run('git', ['cat-file', '-e', `${tip}^{commit}`], { cwd: o.repoDir, env });
        if (known.code !== 0) return { ok: false, message: `Push failed: the branch on Gitea has commits you have not seen (${tip.slice(0, 8)}). Fetch them first.` };
        expected = tip;
      }
    }
    args.push(`--force-with-lease=refs/heads/${o.branch}:${expected}`);
  }
  args.push(o.url, `HEAD:refs/heads/${o.branch}`);
  const r = await run('git', args, { cwd: o.worktree, env });
  if (r.code !== 0) {
    const why = /non-fast-forward|fetch first|rejected/.test(r.stderr)
      ? (o.force ? 'the branch on Gitea has commits you have not seen (lease failed).' : 'non-fast-forward. If you rebased on purpose, push again with force_with_lease.')
      : r.stderr.trim().split('\n').slice(-3).join(' ');
    return { ok: false, message: `Push failed: ${why}` };
  }
  const head = await git(o.worktree, ['rev-parse', 'HEAD'], env);
  await writeLease(o.repoDir, record, head, env);
  return { ok: true, message: `Pushed ${o.branch} (${head.slice(0, 8)}) to Slipway.` };
}
