import { expect, test } from '@playwright/test';
import { git } from '../../src/util/exec.ts';
import { E2E } from './helpers/env.ts';
import { join } from 'node:path';
import { addInlineComment, claudeAmends, claudeCommits, claudeRebasesOnto, hookBlocks, humanPushesToGitHubMain, config, loginAsReviewer, makeRepo, mockGitHub, reviewerApi, prComments, submitReview } from './helpers/slipway.ts';
import { FakeClaude } from './helpers/mcp.ts';

const TEMPLATE = '## Summary\n\n<!-- what and why -->\n\n## Ticket\n\n<!-- DRY-123 -->\n';
const BODY = '## Summary\n\nGreets users — zażółć gęślą jaźń. Adds `greeting.txt`.\n\n## Ticket\n\nDRY-1';

test('one Claude session: open PR → review in Gitea UI → fix → approve → promote to GitHub', async ({ page }) => {
  const repo = await makeRepo('flow', {
    '.github/pull_request_template.md': TEMPLATE,
    'commitlint.config.js': "module.exports = { extends: ['@commitlint/config-conventional'] };\n",
  });
  const claude = await FakeClaude.start(repo.dir);
  try {
    // First use enrolls this Claude as its own Gitea user.
    expect(await claude.ok('slipway_status', { cwd: repo.dir })).toContain(`You are Gitea user: ${E2E.claudeUser}`);
    expect(config().claude?.username).toBe(E2E.claudeUser);

    // start-task: a worktree inside the project, on agent/<id>-<slug>.
    const started = await claude.ok('slipway_start_task', { cwd: repo.dir, task_id: '1', slug: 'greeting' });
    const wt = join(repo.dir, '.slipway', 'worktrees', '1-greeting');
    expect(started).toContain(wt);
    await claudeCommits(wt, 'greeting.txt', 'hello world\n', 'feat: add greeting');

    // The repo's own PR conventions are what Claude gets, not Slipway's default.
    const conventions = await claude.ok('slipway_repo_conventions', { cwd: wt });
    expect(conventions).toContain('.github/pull_request_template.md');
    expect(conventions).toContain('## Ticket');
    expect(conventions).toContain('commitlint.config.js');
    expect(conventions).not.toContain('slipway default template');

    const opened = await claude.ok('slipway_open_pr', { cwd: wt, title: 'feat: add greeting', body: BODY });
    const pr = Number(/PR #(\d+)/.exec(opened)![1]);
    expect((await reviewerApi().getPull(E2E.org, 'flow', pr)).user.login).toBe(E2E.claudeUser);

    // Kevin reviews in the Gitea UI and requests changes.
    await loginAsReviewer(page);
    await addInlineComment(page, 'flow', pr, 1, 'Please uppercase this line');
    await submitReview(page, 'flow', pr, 'Request changes', 'One thing to fix');
    expect(await claude.ok('slipway_status', { cwd: wt })).toContain('State: changes-requested');

    // Kevin: "fix the review" — Claude reads, folds the fix into its commit, force-pushes the clean history, replies.
    const feedback = await claude.ok('slipway_review_comments', { cwd: wt });
    expect(feedback).toContain('One thing to fix');
    expect(feedback).toContain('Please uppercase this line');
    expect(feedback).toContain('greeting.txt:1');
    const commentId = Number(/comment_id: (\d+)/.exec(feedback)![1]);
    await claudeAmends(wt, 'greeting.txt', 'HELLO WORLD\n');
    await claude.ok('slipway_push', { cwd: wt, force_with_lease: true });
    expect(await git(wt, ['log', '--format=%s', 'origin/main..HEAD'])).toBe('feat: add greeting'); // no fixup! in Slipway
    await claude.ok('slipway_reply', { cwd: wt, comment_id: commentId, body: 'Done: uppercased the greeting.' });
    const threads = await reviewerApi().allReviewComments(E2E.org, 'flow', pr);
    expect(threads.some(({ comment }) => comment.user.login === E2E.claudeUser && comment.body === 'Done: uppercased the greeting.')).toBe(true);
    expect(await claude.ok('slipway_status', { cwd: wt })).toContain('State: in-review');

    // Promotion before approval is refused.
    const early = await claude.call('slipway_promote', { cwd: wt });
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(/approve/i);

    // Kevin resolves the thread and approves in the UI.
    await page.goto(`/${E2E.org}/flow/pulls/${pr}`);
    await page.getByRole('button', { name: 'Resolve conversation' }).first().click();
    await submitReview(page, 'flow', pr, 'Approve');
    expect(await claude.ok('slipway_status', { cwd: wt })).toContain('State: approved');

    // After approval the text is frozen for Claude; Kevin may still edit it, and his version is what GitHub gets.
    const frozen = await claude.call('slipway_update_pr', { cwd: wt, title: 'feat: something else' });
    expect(frozen.isError).toBe(true);
    await reviewerApi().editPull(E2E.org, 'flow', pr, { title: 'feat: add a friendly greeting' });

    // While the Slipway PR is open, the hook keeps GitHub out of reach.
    expect(await hookBlocks(wt, 'git push origin agent/1-greeting')).toBe(true);
    expect(await hookBlocks(wt, 'gh pr comment -b hi')).toBe(true);

    // Kevin: "promote".
    const promoted = await claude.ok('slipway_promote', { cwd: wt });
    const gh = (await mockGitHub()).pulls.find((p) => p.head === 'agent/1-greeting')!;
    expect(promoted).toContain(gh.html_url);
    expect(gh).toMatchObject({ base: 'main', title: 'feat: add a friendly greeting', body: BODY, draft: false });
    expect((await mockGitHub()).requests.find((r) => r.method === 'POST')!.headers.authorization).toBe(`Bearer ${E2E.githubToken}`);

    // GitHub got exactly the reviewed commits: the same SHA as in Slipway.
    expect(await git(repo.origin, ['rev-parse', 'agent/1-greeting'])).toBe(await git(wt, ['rev-parse', 'HEAD']));
    expect(await git(repo.origin, ['log', '--format=%s|%an', 'main..agent/1-greeting'])).toBe('feat: add greeting|Claude');
    expect(await git(repo.origin, ['show', 'agent/1-greeting:greeting.txt'])).toBe('HELLO WORLD');

    const closed = await reviewerApi().getPull(E2E.org, 'flow', pr);
    expect(closed.state).toBe('closed');
    expect(closed.merged).toBe(false);
    expect(await prComments('flow', pr)).toContainEqual(expect.stringContaining(`Promoted to GitHub: ${gh.html_url}`));

    // Promoted (Slipway PR closed): the branch now lives on GitHub, so follow-ups for human reviewers go there directly (ADR 0009).
    expect(await hookBlocks(wt, 'git push origin agent/1-greeting')).toBe(false);
    expect(await hookBlocks(wt, 'git push')).toBe(false);
    // A branch without any Slipway PR is still blocked.
    expect(await hookBlocks(wt, 'git push origin agent/2-unreviewed')).toBe(true);
  } finally {
    await claude.close();
  }
});

test('main moved on GitHub: promotion is blocked, Claude rebases in Slipway, a fresh approval is required, then the exact commits ship', async () => {
  const repo = await makeRepo('moving');
  const claude = await FakeClaude.start(repo.dir);
  try {
    await claude.ok('slipway_start_task', { cwd: repo.dir, task_id: '2', slug: 'feature' });
    const wt = join(repo.dir, '.slipway', 'worktrees', '2-feature');
    await claudeCommits(wt, 'feature.txt', 'f\n', 'feat: add feature');
    const pr = Number(/PR #(\d+)/.exec(await claude.ok('slipway_open_pr', { cwd: wt, title: 'feat: add feature', body: 'b' }))![1]);
    await reviewerApi().createReview(E2E.org, 'moving', pr, { event: 'APPROVED', body: '' });

    // Someone merges something else on GitHub in the meantime.
    await humanPushesToGitHubMain(repo, 'CHANGELOG.md', 'v2\n', 'chore: release notes');

    const blocked = await claude.call('slipway_promote', { cwd: wt });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/behind/i);
    expect((await mockGitHub()).pulls.filter((p) => p.head === 'agent/2-feature')).toHaveLength(0);

    // Claude rebases in Slipway (no conflicts here) and force-pushes; the old approval no longer counts.
    await claudeRebasesOnto(wt, 'origin/main');
    await claude.ok('slipway_push', { cwd: wt, force_with_lease: true });
    expect(await claude.ok('slipway_status', { cwd: wt })).toContain('State: in-review');
    expect((await claude.call('slipway_promote', { cwd: wt })).text).toMatch(/approve/i);

    await reviewerApi().createReview(E2E.org, 'moving', pr, { event: 'APPROVED', body: '' });
    await claude.ok('slipway_promote', { cwd: wt });
    expect(await git(repo.origin, ['rev-parse', 'agent/2-feature'])).toBe(await git(wt, ['rev-parse', 'HEAD']));
    expect(await git(repo.origin, ['log', '--format=%s', 'agent/2-feature', '-2'])).toBe('feat: add feature\nchore: release notes');

    // The promoted PR gets merged on GitHub. The next Slipway PR must be diffed against that new main, not a stale one.
    await git(repo.origin, ['update-ref', 'refs/heads/main', 'refs/heads/agent/2-feature']);
    await claude.ok('slipway_start_task', { cwd: repo.dir, task_id: '3', slug: 'next' });
    const wt3 = join(repo.dir, '.slipway', 'worktrees', '3-next');
    await claudeCommits(wt3, 'next.txt', 'n\n', 'feat: next thing');
    const pr3 = Number(/PR #(\d+)/.exec(await claude.ok('slipway_open_pr', { cwd: wt3, title: 'feat: next thing', body: 'b' }))![1]);
    expect(await git(repo.origin, ['rev-parse', 'main'])).toBe((await reviewerApi().req<{ commit: { id: string } }>('GET', `/repos/${E2E.org}/moving/branches/main`)).commit.id);
    const commits = await reviewerApi().req<Array<{ commit: { message: string } }>>('GET', `/repos/${E2E.org}/moving/pulls/${pr3}/commits`);
    expect(commits.map((c) => c.commit.message.trim())).toEqual(['feat: next thing']);
  } finally {
    await claude.close();
  }
});
