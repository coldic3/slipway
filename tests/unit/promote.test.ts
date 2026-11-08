import { describe, expect, it, vi } from 'vitest';
import type { SlipwayConfig } from '../../src/config.ts';
import { PushRejectedError } from '../../src/promote/git.ts';
import { promote, type PromoteDeps, type PromoteOptions } from '../../src/promote/promote.ts';

const config = {
  giteaUrl: 'http://g', admin: { username: 'admin', password: '', token: 'at' }, reviewer: { username: 'kevin', password: '', token: 'rt' }, org: 'repos', repos: { demo: { path: '/repo', base: 'main', github: 'kevin/demo' } },
} as SlipwayConfig;

const opts: PromoteOptions = { repo: 'demo', pr: 4, draft: false, force: false };

function deps(over: { reviews?: any[]; scan?: any; prepare?: any; tests?: number; prOpen?: boolean } = {}) {
  const calls: string[] = [];
  let title = 'Add `x` ąę';
  const d = {
    config,
    githubToken: 'ghtok',
    actor: { username: 'claude-mac', token: 'ct' },
    log: () => {},
    gitea: {
      getPull: vi.fn(async () => ({ number: 4, title, body: '## Context\nBody', state: over.prOpen === false ? 'closed' : 'open', head: { ref: 'agent/4-x', sha: 'abc' }, base: { ref: 'main' }, html_url: 'http://g/kevin/demo/pulls/4', labels: [] })),
      listReviews: vi.fn(async () => over.reviews ?? [{ id: 1, user: { login: 'kevin' }, state: 'APPROVED', commit_id: 'abc', dismissed: false }]),
      comment: vi.fn(async (_o: string, _r: string, _i: number, b: string) => { calls.push(`comment:${b}`); return { id: 1 }; }),
      closePull: vi.fn(async () => { calls.push('close'); }),
      removeLabel: vi.fn(async () => {}),
    },
    github: { upsertPull: vi.fn(async () => { calls.push('github'); return { number: 9, html_url: 'https://github.com/kevin/demo/pull/9', updated: false }; }) },
    prepare: vi.fn(async () => over.prepare ?? { ok: true, worktree: '/wt', head: 'h', baseSha: 'b', fetchedHead: 'abc', cleanup: async () => { calls.push('cleanup'); } }),
    push: vi.fn(async () => { calls.push('push'); }),
    scan: vi.fn(async () => over.scan ?? { ok: true, findings: [] }),
    runTests: vi.fn(async () => ({ code: over.tests ?? 0, stdout: 'test output', stderr: '' })),
    originAuth: vi.fn(async () => ['-c', 'x']),
    setTitle: (t: string) => { title = t; },
  };
  return { d: d as unknown as PromoteDeps & { setTitle: (t: string) => void }, calls, raw: d };
}

describe('promote', () => {
  it('refuses a PR that is not approved (exit 5) without touching git or GitHub', async () => {
    const { d, raw } = deps({ reviews: [] });
    expect((await promote(opts, d)).code).toBe(5);
    expect(raw.prepare).not.toHaveBeenCalled();
    expect(raw.github.upsertPull).not.toHaveBeenCalled();
  });

  it('fetches the PR branch as the acting Gitea user', async () => {
    const { d, raw } = deps();
    await promote(opts, d);
    const prepArgs = (raw.prepare.mock.calls[0] as any)[0];
    expect(prepArgs.reviewAuthArgs.join(' ')).toContain(Buffer.from('claude-mac:ct').toString('base64'));
  });

  it('refuses when the approval is stale (new commits pushed after approval) or came from the agent', async () => {
    expect((await promote(opts, deps({ reviews: [{ id: 1, user: { login: 'kevin' }, state: 'APPROVED', commit_id: 'old', dismissed: false }] }).d)).code).toBe(5);
    expect((await promote(opts, deps({ reviews: [{ id: 1, user: { login: 'agent-bot' }, state: 'APPROVED', commit_id: 'abc', dismissed: false }] }).d)).code).toBe(5);
  });

  it('refuses when the branch moved between the approval check and the fetch (exit 5, nothing pushed)', async () => {
    const { d, raw, calls } = deps({ prepare: { ok: true, worktree: '/wt', head: 'h', baseSha: 'b', fetchedHead: 'sneaky', cleanup: async () => { calls.push('cleanup'); } } });
    expect((await promote(opts, d)).code).toBe(5);
    expect(raw.push).not.toHaveBeenCalled();
    expect(calls).toContain('cleanup');
  });

  it('--force promotes a non-approved PR', async () => {
    const { d } = deps({ reviews: [] });
    expect((await promote({ ...opts, force: true }, d)).code).toBe(0);
  });

  it('refuses a closed PR (exit 1)', async () => {
    const { d } = deps({ prOpen: false });
    expect((await promote(opts, d)).code).toBe(1);
  });

  it('happy path: pushes, creates the GitHub PR with the exact Gitea title/body read after the checks, comments, labels, closes', async () => {
    const { d, calls, raw } = deps();
    raw.scan.mockImplementation(async () => { d.setTitle('Edited during scan'); return { ok: true, findings: [] }; });
    const r = await promote({ ...opts, draft: true }, d);
    expect(r).toEqual({ code: 0, url: 'https://github.com/kevin/demo/pull/9' });
    expect(raw.github.upsertPull).toHaveBeenCalledWith({ repo: 'kevin/demo', head: 'agent/4-x', base: 'main', title: 'Edited during scan', body: '## Context\nBody', draft: true });
    expect(raw.push).toHaveBeenCalledWith(expect.objectContaining({ repoDir: '/repo', reviewedHead: 'abc', worktree: '/wt', branch: 'agent/4-x', authArgs: ['-c', 'x'] }));
    expect(raw.scan).toHaveBeenCalledWith('/repo', 'b..h');
    expect(calls.indexOf('push')).toBeLessThan(calls.indexOf('github'));
    expect(calls.slice(-3)).toEqual(['comment:🚢 Promoted to GitHub: https://github.com/kevin/demo/pull/9', 'close', 'cleanup']);
  });

  it('--base overrides the GitHub target branch', async () => {
    const { d, raw } = deps();
    await promote({ ...opts, base: 'release' }, d);
    expect(raw.prepare).toHaveBeenCalledWith(expect.objectContaining({ base: 'release' }));
    expect(raw.github.upsertPull).toHaveBeenCalledWith(expect.objectContaining({ base: 'release' }));
  });

  it('branch behind origin/<base> → no rewriting: comment asks for a rebase in Slipway and a new approval, exit 2', async () => {
    const { d, calls, raw } = deps({ prepare: { ok: false, behindBy: 3 } });
    const r = await promote(opts, d);
    expect(r.code).toBe(2);
    const comment = calls.find((c) => c.startsWith('comment:'))!;
    expect(comment).toMatch(/3 commit/);
    expect(comment).toMatch(/rebase/i);
    expect(comment).toMatch(/approv/i);
    expect(raw.github.upsertPull).not.toHaveBeenCalled();
    expect(raw.push).not.toHaveBeenCalled();
  });

  it('passes no history-rewriting options to the git engine', async () => {
    const { d, raw } = deps();
    await promote(opts, d);
    const args = (raw.prepare.mock.calls[0] as any)[0];
    expect(args).not.toHaveProperty('strategy');
    expect(args).not.toHaveProperty('asMe');
    expect(args).not.toHaveProperty('title');
  });

  it('secret found → blocked, comment names rule/file/line, nothing pushed, exit 3', async () => {
    const { d, calls, raw } = deps({ scan: { ok: false, findings: [{ rule: 'aws-access-token', file: 'config.env', line: 1, commit: 'c1' }] } });
    expect((await promote(opts, d)).code).toBe(3);
    expect(raw.push).not.toHaveBeenCalled();
    expect(calls.find((c) => c.startsWith('comment:'))).toMatch(/aws-access-token.*config\.env:1/);
    expect(calls).toContain('cleanup');
  });

  it('scanner unavailable → blocked (fail closed), exit 3', async () => {
    const { d, raw, calls } = deps({ scan: { ok: false, findings: [], error: 'gitleaks is not available' } });
    expect((await promote(opts, d)).code).toBe(3);
    expect(raw.push).not.toHaveBeenCalled();
    expect(calls.some((c) => c.startsWith('comment:') && c.includes('gitleaks is not available'))).toBe(true);
  });

  it('failing tests → exit 4, comment with output, nothing pushed', async () => {
    const { d, calls, raw } = deps({ tests: 1 });
    expect((await promote({ ...opts, testCmd: 'npm test' }, d)).code).toBe(4);
    expect(raw.runTests).toHaveBeenCalledWith('npm test', '/wt');
    expect(raw.push).not.toHaveBeenCalled();
    expect(calls.some((c) => c.includes('test output'))).toBe(true);
  });

  it('refuses to run without a GitHub token', async () => {
    const { d } = deps();
    expect((await promote(opts, { ...d, githubToken: '' })).code).toBe(1);
  });

  it('GitHub branch has commits missing from the Slipway PR → comment on the PR, readable result, no GitHub PR call', async () => {
    const { d, calls, raw } = deps();
    raw.push.mockRejectedValueOnce(new PushRejectedError('The GitHub branch agent/4-x has commits that are not in the Slipway PR.'));
    const r = await promote(opts, d);
    expect(r.code).toBe(1);
    expect(r.message).toMatch(/not in the Slipway PR/);
    expect(calls.some((c) => c.startsWith('comment:') && /not in the Slipway PR/.test(c))).toBe(true);
    expect(raw.github.upsertPull).not.toHaveBeenCalled();
    expect(calls).toContain('cleanup');
  });

  it('addresses the repo through the org and accepts only the reviewer\'s approval', async () => {
    const { d, raw } = deps();
    await promote(opts, d);
    expect(raw.gitea.getPull).toHaveBeenCalledWith('repos', 'demo', 4);
    expect(raw.gitea.comment.mock.calls.every((c: unknown[]) => c[0] === 'repos')).toBe(true);
    // An approval by the technical admin does not count.
    const adminOnly = deps({ reviews: [{ id: 1, user: { login: 'admin' }, state: 'APPROVED', commit_id: 'abc', dismissed: false }] });
    expect((await promote(opts, adminOnly.d)).code).toBe(5);
  });
});
