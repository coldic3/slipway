import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { git } from '../../src/util/exec.ts';
import { E2E, e2eEnv } from './helpers/env.ts';
import { FakeClaude } from './helpers/mcp.ts';
import { AGENT_ID, claudeCommits, makeRepo, mockGitHub, prComments, reviewerApi } from './helpers/slipway.ts';

const prNumber = (text: string) => Number(/PR #(\d+)/.exec(text)![1]);
// Gitea timestamps have second precision; an approval must come strictly after a base change (ADR 0014).
const nextSecond = () => new Promise((r) => setTimeout(r, 1_100));

test('split a PR into a stack: close the old one, retarget, verify in Slipway, promote parent then child', async () => {
  const repo = await makeRepo('stack');
  const claude = await FakeClaude.start(repo.dir);
  try {
    // The original, too-big PR.
    await claude.ok('slipway_start_task', { cwd: repo.dir, task_id: '1', slug: 'big' });
    const wtBig = join(repo.dir, '.slipway', 'worktrees', '1-big');
    await claudeCommits(wtBig, 'big.txt', 'all of it\n', 'feat: everything');
    const big = prNumber(await claude.ok('slipway_open_pr', { cwd: wtBig, title: 'feat: everything', body: 'b' }));

    // Split: parent on main, child stacked on the parent.
    await claude.ok('slipway_start_task', { cwd: repo.dir, task_id: '2', slug: 'parent' });
    const wtParent = join(repo.dir, '.slipway', 'worktrees', '2-parent');
    await claudeCommits(wtParent, 'parent.txt', 'p\n', 'feat: parent part');
    const parent = prNumber(await claude.ok('slipway_open_pr', { cwd: wtParent, title: 'feat: parent part', body: 'b' }));

    await claude.ok('slipway_start_task', { cwd: repo.dir, task_id: '3', slug: 'child' });
    const wtChild = join(repo.dir, '.slipway', 'worktrees', '3-child');
    await git(wtChild, ['reset', '-q', '--hard', 'agent/2-parent'], e2eEnv(AGENT_ID));
    await claudeCommits(wtChild, 'child.txt', 'c\n', 'feat: child part');
    expect((await claude.call('slipway_open_pr', { cwd: wtChild, title: 't', body: 'b', base: 'agent/9-nope' })).text).toMatch(/does not exist/);
    const child = prNumber(await claude.ok('slipway_open_pr', { cwd: wtChild, title: 'feat: child part', body: 'b', base: 'agent/2-parent' }));
    const childCommits = await reviewerApi().req<Array<{ commit: { message: string } }>>('GET', `/repos/${E2E.org}/stack/pulls/${child}/commits`);
    expect(childCommits.map((c) => c.commit.message.trim())).toEqual(['feat: child part']);

    // Close the superseded PR with a reason.
    expect(await claude.ok('slipway_close_pr', { cwd: repo.dir, pr: big, reason: `Superseded by #${parent} and #${child}` })).toMatch(/Closed PR/);
    expect((await reviewerApi().getPull(E2E.org, 'stack', big)).state).toBe('closed');
    expect(await prComments('stack', big)).toContain(`Closed by ${E2E.claudeUser}: Superseded by #${parent} and #${child}`);

    // Claude verifies the stack itself.
    const open = await claude.ok('slipway_list_prs', { cwd: repo.dir });
    expect(open).toContain(`#${child} feat: child part · agent/3-child → agent/2-parent · in-review`);
    expect(open).not.toContain(`#${big} `);
    expect(await claude.ok('slipway_list_prs', { cwd: repo.dir, state: 'closed' })).toContain(`#${big} feat: everything · agent/1-big → main · closed`);

    // Retargeting an approved PR: allowed, but the approval stops counting (Gitea keeps it).
    await reviewerApi().createReview(E2E.org, 'stack', child, { event: 'APPROVED', body: '' });
    expect(await claude.ok('slipway_status', { cwd: wtChild })).toContain('State: approved');
    await nextSecond();
    expect((await claude.call('slipway_update_pr', { cwd: wtChild, base: 'main', title: 'x' })).text).toMatch(/nothing was changed/);
    expect(await claude.ok('slipway_update_pr', { cwd: wtChild, base: 'main' })).toMatch(/agent\/2-parent → main[\s\S]*approval no longer counts/);
    expect(await claude.ok('slipway_status', { cwd: wtChild })).toMatch(/State: in-review \(approved before the base changed/);
    await claude.ok('slipway_update_pr', { cwd: wtChild, base: 'agent/2-parent' });
    const details = await claude.ok('slipway_pr', { cwd: wtChild, diff: true });
    expect(details).toMatch(/base agent\/2-parent → main/);
    expect(details).toMatch(/base main → agent\/2-parent/);
    expect(details).toMatch(/feat: child part/);
    expect(details).toMatch(/\+\+\+ b\/child\.txt/);

    // The child cannot go before its parent.
    await nextSecond();
    await reviewerApi().createReview(E2E.org, 'stack', child, { event: 'APPROVED', body: '' });
    const early = await claude.call('slipway_promote', { cwd: wtChild });
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(new RegExp(`promote #${parent} first`));

    // Parent first, then the child onto the parent's branch: only its own commit reaches GitHub in its PR.
    await reviewerApi().createReview(E2E.org, 'stack', parent, { event: 'APPROVED', body: '' });
    await claude.ok('slipway_promote', { cwd: wtParent });
    await claude.ok('slipway_promote', { cwd: wtChild });
    const gh = (await mockGitHub()).pulls;
    expect(gh.find((p) => p.head === 'agent/2-parent')?.base).toBe('main');
    expect(gh.find((p) => p.head === 'agent/3-child')?.base).toBe('agent/2-parent');
    expect(await git(repo.origin, ['log', '--format=%s', 'agent/2-parent..agent/3-child'])).toBe('feat: child part');
    expect(await claude.ok('slipway_list_prs', { cwd: repo.dir, state: 'closed' })).toMatch(new RegExp(`#${child} .* promoted \\(https://github.com/`));
  } finally {
    await claude.close();
  }
});
