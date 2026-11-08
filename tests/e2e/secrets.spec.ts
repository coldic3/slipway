import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { run } from '../../src/util/exec.ts';
import { E2E, e2eEnv, ROOT } from './helpers/env.ts';
import { claudeStartsTask, makeRepo, mockGitHub, reviewerApi, prComments } from './helpers/slipway.ts';
import { FakeClaude } from './helpers/mcp.ts';

const KEY = 'AKIA' + 'Z7XQ3MPLR2VBN4TD';

test('promote.sh refuses unapproved PRs; a planted secret blocks slipway_promote', async () => {
  const repo = await makeRepo('leaky');
  const wt = await claudeStartsTask(repo, { branch: 'agent/4-config', file: 'config.env', content: `AWS_ACCESS_KEY_ID=${KEY}\n`, message: 'Add config' });
  const claude = await FakeClaude.start(wt);
  try {
    const pr = Number(/PR #(\d+)/.exec(await claude.ok('slipway_open_pr', { cwd: wt, title: 'Add config', body: 'Adds config' }))![1]);

    // Kevin's terminal entry point (Phase 0): token from `gh auth token`.
    const { mockUrl } = JSON.parse(readFileSync(E2E.stateFile, 'utf8'));
    const shellEnv = e2eEnv({ PATH: `${E2E.fakeBin}:${process.env.PATH}`, SLIPWAY_GITHUB_API: mockUrl });
    delete shellEnv.SLIPWAY_GITHUB_TOKEN;
    const notApproved = await run(join(ROOT, 'scripts', 'promote.sh'), ['leaky', String(pr)], { env: shellEnv });
    expect(notApproved.code, notApproved.stderr).toBe(5);
    expect(notApproved.stderr).toMatch(/not approved/);

    await reviewerApi().createReview(E2E.org, 'leaky', pr, { event: 'APPROVED', body: '' });
    const blocked = await claude.call('slipway_promote', { cwd: wt });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/secret/i);
    expect(blocked.text).not.toContain(KEY);

    const comments = (await prComments('leaky', pr)).join('\n');
    expect(comments).toMatch(/aws-access-token.*config\.env:1/);
    expect(comments).not.toContain(KEY);
    expect((await mockGitHub()).pulls.filter((p) => p.head === 'agent/4-config')).toHaveLength(0);
    expect((await reviewerApi().getPull(E2E.org, 'leaky', pr)).state).toBe('open');
  } finally {
    await claude.close();
  }
});
