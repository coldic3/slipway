import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, run } from '../util/exec.ts';
import { leaseRef, readLease, writeLease } from '../util/lease-refs.ts';

export interface PrepareOptions {
  /** Kevin's clone (has remote "origin" = GitHub). */
  repoDir: string;
  /** Gitea clone URL of the repo and the auth args to fetch from it. */
  reviewUrl: string;
  reviewAuthArgs: string[];
  /** Auth args for fetching from origin (GitHub); empty for local/ssh origins. */
  originAuthArgs?: string[];
  branch: string;
  base: string;
  /** Environment for git. */
  env?: NodeJS.ProcessEnv;
}

export type PrepareResult =
  | { ok: true; worktree: string; head: string; baseSha: string; fetchedHead: string; cleanup: () => Promise<void> }
  | { ok: false; behindBy: number };

/**
 * Git settings forced for every promotion git call: the agent shares this .git directory, so repository hooks,
 * fsmonitor and signing prompts must never run with the promoter's credentials or hang a promotion.
 */
export function hardenedGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const forced: Array<[string, string]> = [
    ['core.hooksPath', '/dev/null'],
    ['core.fsmonitor', 'false'],
    ['commit.gpgsign', 'false'],
  ];
  const n = Number(env.GIT_CONFIG_COUNT || 0);
  const out: NodeJS.ProcessEnv = { ...env, GIT_CONFIG_COUNT: String(n + forced.length) };
  forced.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${n + i}`] = k;
    out[`GIT_CONFIG_VALUE_${n + i}`] = v;
  });
  return out;
}

/**
 * Exact promotion (ADR 0006): fetches the reviewed branch and a fresh origin/<base>, and checks out the reviewed commits
 * unchanged in a temporary worktree (for the secret scan and tests). Nothing is rebased, folded or re-authored.
 * A branch that does not contain the current origin/<base> is refused (ok:false, behindBy): the agent rebases in Slipway
 * and the user approves again. The caller must call cleanup().
 */
export async function prepareBranch(o: PrepareOptions): Promise<PrepareResult> {
  const env = hardenedGitEnv(o.env ?? process.env);
  const promoteRef = `refs/slipway/promote/${o.branch}`;
  const upstream = `refs/remotes/origin/${o.base}`;
  await git(o.repoDir, [...(o.originAuthArgs ?? []), 'fetch', '--quiet', 'origin', `+refs/heads/${o.base}:${upstream}`], env);
  await git(o.repoDir, [...o.reviewAuthArgs, '-c', 'credential.helper=', 'fetch', '--quiet', o.reviewUrl, `+refs/heads/${o.branch}:${promoteRef}`], env);
  const fetchedHead = await git(o.repoDir, ['rev-parse', promoteRef], env);
  const baseSha = await git(o.repoDir, ['rev-parse', upstream], env);

  const behindBy = Number(await git(o.repoDir, ['rev-list', '--count', `${fetchedHead}..${baseSha}`], env));
  if (behindBy > 0) {
    await run('git', ['update-ref', '-d', promoteRef], { cwd: o.repoDir, env });
    return { ok: false, behindBy };
  }

  const worktree = mkdtempSync(join(tmpdir(), 'slipway-promote-'));
  rmSync(worktree, { recursive: true });
  await git(o.repoDir, ['worktree', 'add', '--quiet', '--detach', worktree, fetchedHead], env);
  const cleanup = async () => {
    await run('git', ['worktree', 'remove', '--force', worktree], { cwd: o.repoDir, env });
    rmSync(worktree, { recursive: true, force: true });
    await run('git', ['worktree', 'prune'], { cwd: o.repoDir, env });
    await run('git', ['update-ref', '-d', promoteRef], { cwd: o.repoDir, env });
  };
  return { ok: true, worktree, head: fetchedHead, baseSha, fetchedHead, cleanup };
}

/** Whether origin (GitHub) has the branch: ls-remote, so nothing is fetched. Throws when origin cannot be reached. */
export async function originHasBranch(repoDir: string, branch: string, authArgs: string[] = [], env?: NodeJS.ProcessEnv): Promise<boolean> {
  const r = await run('git', [...authArgs, 'ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`],
    { cwd: repoDir, env: hardenedGitEnv(env ?? process.env), timeoutMs: 60_000 });
  if (r.code === 0) return true;
  if (r.code === 2) return false;
  throw new Error(`could not read branches from GitHub (origin): ${r.stderr.trim().split('\n').pop()}`);
}

export interface PushOptions {
  /** Kevin's clone; remembers the last promoted SHA per branch in refs/slipway/promoted/<branch>. */
  repoDir: string;
  worktree: string;
  branch: string;
  /** The approved Slipway head before history cleanup (prepareBranch's fetchedHead). */
  reviewedHead: string;
  /** e.g. bearerAuthArgs('https://github.com/', token) — never persisted. */
  authArgs: string[];
  env?: NodeJS.ProcessEnv;
}

/** The GitHub branch can't be updated without losing commits that were never reviewed in Slipway. */
export class PushRejectedError extends Error {}

/**
 * Pushes HEAD to origin/<branch> without ever dropping commits that only exist on GitHub. The lease (expected remote SHA) is:
 * - "must not exist" for a new branch;
 * - the SHA Slipway pushed last time (re-promotion);
 * - for a branch created outside Slipway (e.g. a PR opened on GitHub before Slipway), its current SHA, but only if
 *   every commit on it is already part of the reviewed Slipway branch. Otherwise PushRejectedError.
 */
export async function pushToOrigin(o: PushOptions): Promise<void> {
  const env = hardenedGitEnv(o.env ?? process.env);
  const recordRef = leaseRef('promoted', o.branch);
  const githubRef = `refs/slipway/github/${o.branch}`;
  const recorded = await readLease(o.repoDir, recordRef, env);

  // What is on GitHub right now (objects included, for the ancestry check)?
  await run('git', ['update-ref', '-d', githubRef], { cwd: o.repoDir, env });
  await run('git', [...o.authArgs, 'fetch', '--quiet', 'origin', `+refs/heads/${o.branch}:${githubRef}`], { cwd: o.repoDir, env });
  const seen = await run('git', ['rev-parse', '-q', '--verify', githubRef], { cwd: o.repoDir, env });
  const remote = seen.code === 0 ? seen.stdout.trim() : '';

  let expected = '';
  if (remote && remote !== recorded) {
    const contained = await run('git', ['merge-base', '--is-ancestor', remote, o.reviewedHead], { cwd: o.repoDir, env });
    if (contained.code !== 0) {
      throw new PushRejectedError(
        `The GitHub branch ${o.branch} has commits that are not in the Slipway PR (GitHub is at ${remote.slice(0, 8)}). ` +
          `Bring them into the Slipway branch (e.g. rebase onto origin/${o.branch}), push and get it re-approved, or delete the GitHub branch; then promote again.`,
      );
    }
    expected = remote;
  } else if (remote) {
    expected = recorded;
  }
  const push = await run('git', [...o.authArgs, 'push', '--quiet', `--force-with-lease=refs/heads/${o.branch}:${expected}`, 'origin', `HEAD:refs/heads/${o.branch}`], { cwd: o.worktree, env });
  if (push.code !== 0) {
    if (/stale info|rejected/.test(push.stderr)) {
      throw new PushRejectedError(`The GitHub branch ${o.branch} changed while promoting. Promote again.`);
    }
    throw new Error(`git push to GitHub failed: ${push.stderr.trim().split('\n').slice(-3).join(' ')}`);
  }
  await writeLease(o.repoDir, recordRef, await git(o.worktree, ['rev-parse', 'HEAD'], env), env);
}
