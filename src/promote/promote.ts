import type { SlipwayConfig } from '../config.ts';
import { approvalOf } from '../core/approval.ts';
import type { GiteaClient } from '../gitea/client.ts';
import type { GitHubClient } from '../github/client.ts';
import { run, type ExecResult } from '../util/exec.ts';
import { basicAuthArgs, bearerAuthArgs } from '../util/git-auth.ts';
import { originHasBranch, prepareBranch, pushToOrigin, PushRejectedError } from './git.ts';
import { scanSecrets, type ScanResult } from './secrets.ts';

/** CONFLICT = the branch is behind its base: rebase it in Slipway first (no rewriting at promotion). */
export const EXIT = { OK: 0, ERROR: 1, CONFLICT: 2, SECRETS: 3, TESTS: 4, NOT_APPROVED: 5 } as const;

export interface PromoteOptions {
  repo: string;
  pr: number;
  draft: boolean;
  /** GitHub target branch; defaults to the PR's base in Slipway (ADR 0014). Another branch needs `force`. */
  base?: string;
  testCmd?: string;
  /** Promote even if the PR is not in the approved state. */
  force: boolean;
}

export interface PromoteDeps {
  config: SlipwayConfig;
  githubToken: string;
  gitea: Pick<GiteaClient, 'getPull' | 'listReviews' | 'timeline' | 'listPulls' | 'comment' | 'closePull'>;
  /** Gitea account used to fetch the PR branch (the Claude user from the plugin, or Slipway's admin from the CLI). */
  actor: { username: string; token: string };
  github: Pick<GitHubClient, 'upsertPull' | 'mergedPullFor'>;
  prepare: typeof prepareBranch;
  push: typeof pushToOrigin;
  /** Whether GitHub (origin) has a branch (stacked PRs: the parent must be there). */
  originHasBranch: typeof originHasBranch;
  scan: (repoDir: string, range: string) => Promise<ScanResult>;
  runTests: (cmd: string, cwd: string) => Promise<ExecResult>;
  /** git auth args for origin (GitHub) for this clone. */
  originAuth: (repoDir: string) => Promise<string[]>;
  log: (msg: string) => void;
}

export interface PromoteResult { code: number; url?: string; message?: string }

export async function promote(o: PromoteOptions, d: PromoteDeps): Promise<PromoteResult> {
  const fail = (code: number, message: string): PromoteResult => {
    d.log(message);
    return { code, message };
  };
  if (!d.githubToken) return fail(EXIT.ERROR, 'No GitHub token: log in with `gh auth login` (or set SLIPWAY_GITHUB_TOKEN)');
  const entry = d.config.repos[o.repo];
  if (!entry) return fail(EXIT.ERROR, `Unknown repo "${o.repo}"`);
  // Repos live in the org; only the reviewer's approval counts (ADR 0005).
  const owner = d.config.org;
  const approver = d.config.reviewer.username;

  const pr = await d.gitea.getPull(owner, o.repo, o.pr);
  if (pr.state !== 'open') return fail(EXIT.ERROR, `PR #${o.pr} is ${pr.state}; only open PRs can be promoted`);
  const approval = await approvalOf(d.gitea, owner, o.repo, pr, approver);
  if (!approval.approved && !o.force) {
    const why = approval.warning ? ` (${approval.warning})`
      : approval.baseChangedAfterApproval ? ' (it was approved before its base changed)' : '';
    return fail(EXIT.NOT_APPROVED, `PR #${o.pr} is not approved by ${approver} at its current head and base${why}. Approve it in Gitea.`);
  }

  // What was reviewed is the diff against the PR's base in Slipway, so that is the GitHub target (ADR 0014).
  const base = o.base ?? pr.base.ref;
  if (base !== pr.base.ref && !o.force) {
    return fail(EXIT.ERROR, `PR #${o.pr} targets ${pr.base.ref} in Slipway, so promoting it to ${base} would publish a diff nobody reviewed. Change its base in Slipway (slipway_update_pr), rebase, push and get a fresh approval.`);
  }
  const branch = pr.head.ref;
  const originAuthArgs = await d.originAuth(entry.path);
  if (base !== entry.base) {
    const retarget = `change its base in Slipway to ${entry.base} (slipway_update_pr base="${entry.base}"), rebase onto origin/${entry.base}, push with force_with_lease and get a fresh approval`;
    if (!(await d.originHasBranch(entry.path, base, originAuthArgs))) {
      const parent = (await d.gitea.listPulls(owner, o.repo, 'open')).find((p) => p.head.ref === base);
      return fail(EXIT.ERROR, parent
        ? `PR #${o.pr} is stacked on #${parent.number} (${base}), which is not on GitHub yet: promote #${parent.number} first.`
        : `PR #${o.pr} targets ${base}, which is not on GitHub (was its parent merged and the branch deleted?): ${retarget}.`);
    }
    const merged = await d.github.mergedPullFor(entry.github, base);
    if (merged) {
      return fail(EXIT.ERROR, `PR #${o.pr} targets ${base}, whose GitHub PR ${merged.html_url} is already merged: ${retarget}.`);
    }
  }
  d.log(`preparing ${branch} (exact promotion onto origin/${base})`);
  const prep = await d.prepare({
    repoDir: entry.path,
    reviewUrl: `${d.config.giteaUrl.replace(/\/$/, '')}/${owner}/${o.repo}.git`,
    reviewAuthArgs: basicAuthArgs(d.actor.username, d.actor.token),
    originAuthArgs,
    branch,
    base,
  });

  if (!prep.ok) {
    await d.gitea.comment(owner, o.repo, o.pr,
      `⚠️ Promotion blocked: the branch is ${prep.behindBy} commit(s) behind \`origin/${base}\`. Slipway promotes exactly what was reviewed, so rebase the branch onto \`origin/${base}\` in Slipway (resolving conflicts), push it, and approve it again.`);
    return fail(EXIT.CONFLICT, `branch is ${prep.behindBy} commit(s) behind origin/${base}: rebase it in Slipway, push, and approve again`);
  }

  try {
    if (prep.fetchedHead !== pr.head.sha && !o.force) {
      return fail(EXIT.NOT_APPROVED, `PR #${o.pr} changed after its approval check (${pr.head.sha.slice(0, 8)} → ${prep.fetchedHead.slice(0, 8)}); review the new commits and approve again.`);
    }
    const scan = await d.scan(entry.path, `${prep.baseSha}..${prep.head}`);
    if (!scan.ok) {
      const list = scan.findings.map((f) => `- \`${f.rule}\` in \`${f.file}:${f.line}\` (commit ${f.commit.slice(0, 8)})`).join('\n');
      await d.gitea.comment(owner, o.repo, o.pr, scan.error
        ? `⚠️ Promotion blocked: the secret scan could not run (${scan.error}).`
        : `⚠️ Promotion blocked: gitleaks found possible secrets:\n\n${list}\n\nRemove them from the history (not just the latest commit) and rotate the credentials.`);
      return fail(EXIT.SECRETS, scan.error ?? `secret scan found ${scan.findings.length} issue(s)`);
    }

    if (o.testCmd) {
      d.log(`running tests: ${o.testCmd}`);
      const t = await d.runTests(o.testCmd, prep.worktree);
      if (t.code !== 0) {
        const tail = (t.stdout + '\n' + t.stderr).trim().split('\n').slice(-40).join('\n');
        await d.gitea.comment(owner, o.repo, o.pr, `⚠️ Promotion blocked: \`${o.testCmd}\` failed (exit ${t.code}).\n\n\`\`\`\n${tail}\n\`\`\``);
        return fail(EXIT.TESTS, `tests failed (exit ${t.code})`);
      }
    }

    // Gitea is the source of truth: re-read the title/body right before publishing.
    const fresh = await d.gitea.getPull(owner, o.repo, o.pr);
    d.log(`pushing ${branch} to origin`);
    try {
      await d.push({ repoDir: entry.path, worktree: prep.worktree, branch, reviewedHead: prep.fetchedHead, authArgs: originAuthArgs });
    } catch (e) {
      if (!(e instanceof PushRejectedError)) throw e;
      await d.gitea.comment(owner, o.repo, o.pr, `⚠️ Promotion blocked: ${e.message}`);
      return fail(EXIT.ERROR, e.message);
    }
    const gh = await d.github.upsertPull({ repo: entry.github, head: branch, base, title: fresh.title, body: fresh.body ?? '', draft: o.draft });
    await d.gitea.comment(owner, o.repo, o.pr, `🚢 Promoted to GitHub: ${gh.html_url}`);
    await d.gitea.closePull(owner, o.repo, o.pr);
    d.log(`promoted → ${gh.html_url}`);
    return { code: EXIT.OK, url: gh.html_url };
  } finally {
    await prep.cleanup();
  }
}

/** Auth args for an https://github.com origin; ssh and local origins use their own auth. */
export async function githubOriginAuth(repoDir: string, token: string): Promise<string[]> {
  const url = (await run('git', ['remote', 'get-url', 'origin'], { cwd: repoDir })).stdout.trim();
  const m = /^(https:\/\/[^/]+\/)/.exec(url);
  return m && token ? bearerAuthArgs(m[1]!, token) : [];
}

export function runShell(cmd: string, cwd: string): Promise<ExecResult> {
  return run('sh', ['-c', cmd], { cwd, timeoutMs: 30 * 60_000 });
}

export { scanSecrets };
