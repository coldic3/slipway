import { expect, test } from '@playwright/test';
import { GiteaError } from '../../src/gitea/client.ts';
import { run } from '../../src/util/exec.ts';
import { basicAuthArgs } from '../../src/util/git-auth.ts';
import { E2E, e2eEnv, GITEA_URL } from './helpers/env.ts';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { adminApi, claudeApi, claudeStartsTask, config, slipway, loginAsReviewer, makeRepo, reviewerApi } from './helpers/slipway.ts';
import { FakeClaude } from './helpers/mcp.ts';

test.describe('setup and guard rails', () => {
  test('repo add configures a Gitea repo where nothing can be merged, and Claude cannot push to main', async ({ page }) => {
    const repo = await makeRepo('guarded');
    const api = reviewerApi();
    const r = await api.getRepo(E2E.org, 'guarded');
    expect(r).toMatchObject({ allow_merge_commits: false, allow_rebase: false, allow_rebase_explicit: false, allow_squash_merge: false, allow_fast_forward_only_merge: false, allow_manual_merge: false });
    const protections = await adminApi().req<Array<Record<string, unknown>>>('GET', `/repos/${E2E.org}/guarded/branch_protections`);
    expect(protections[0]).toMatchObject({ rule_name: 'main', enable_merge_whitelist: true, merge_whitelist_usernames: [], push_whitelist_usernames: [E2E.admin], block_admin_merge_override: true });

    const wt = await claudeStartsTask(repo, { branch: 'agent/2-x', file: 'x.txt', content: 'x\n', message: 'Add x' });
    const claude = await FakeClaude.start(wt);
    try {
      const pr = Number(/PR #(\d+)/.exec(await claude.ok('slipway_open_pr', { cwd: wt, title: 'Add x', body: 'body' }))![1]);
      for (const client of [claudeApi(), reviewerApi(), adminApi()]) {
        const err = await client.mergePull(E2E.org, 'guarded', pr).catch((e) => e);
        expect(err).toBeInstanceOf(GiteaError);
        expect((err as GiteaError).status).toBe(405);
      }
      // Branch protection holds even with Claude's own credentials.
      const c = config().claude!;
      const push = await run('git', [...basicAuthArgs(c.username, c.token), 'push', `${GITEA_URL}/${E2E.org}/guarded.git`, 'HEAD:main'], { cwd: wt, env: e2eEnv() });
      expect(push.code).not.toBe(0);
      expect(push.stderr).toMatch(/declined|protected|not allowed/i);

      await loginAsReviewer(page);
      await page.goto(`/${E2E.org}/guarded/pulls/${pr}`);
      await expect(page.getByRole('heading', { name: /Add x/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /Create merge commit|Rebase then|Squash|Fast-forward|Merge/i })).toHaveCount(0);
    } finally {
      await claude.close();
    }
  });

  test('repos registered after enrollment are open to the Claude user', async () => {
    expect(config().claude).toBeDefined();
    const repo = await makeRepo('later');
    const wt = await claudeStartsTask(repo, { branch: 'agent/5-y', file: 'y.txt', content: 'y\n', message: 'Add y' });
    const claude = await FakeClaude.start(wt);
    try {
      expect(await claude.ok('slipway_open_pr', { cwd: wt, title: 'Add y', body: 'b' })).toMatch(/Opened PR #\d+/);
    } finally {
      await claude.close();
    }
  });

  test('gitea listens on 127.0.0.1 only and needs sign-in', async () => {
    expect((await fetch(`${GITEA_URL}/api/v1/repos/search`)).status).toBe(403);
    // Not reachable on any other address of this machine.
    const others = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
    for (const ip of others) {
      const err = await fetch(`http://${ip}:${E2E.giteaPort}/api/healthz`, { signal: AbortSignal.timeout(3000) }).then(() => null, (e) => e);
      expect(err, `${ip}:${E2E.giteaPort} must not answer`).not.toBeNull();
    }
  });

  test('after Gitea stops (e.g. a reboot), the plugin starts it again on its next call', async () => {
    test.skip(E2E.runtime !== 'native', 'Docker restarts the container by itself');
    const repo = await makeRepo('autostart');
    const wt = await claudeStartsTask(repo, { branch: 'agent/9-z', file: 'z.txt', content: 'z\n', message: 'Add z' });
    expect((await slipway(['down'])).code).toBe(0);
    expect((await slipway(['status'])).stdout).toMatch(/^stopped/);
    const claude = await FakeClaude.start(wt);
    try {
      expect(await claude.ok('slipway_status', { cwd: wt })).toMatch(/autostart/);
    } finally {
      await claude.close();
    }
    expect((await slipway(['status'])).stdout).toMatch(/^running at/);
  });

  test('"Remember this device" keeps you logged in for 365 days', async ({ page, context }) => {
    await page.goto('/user/login');
    await page.getByLabel(/Username or Email/i).fill(E2E.reviewer);
    await page.getByLabel(/Password/i).fill(E2E.password);
    await page.getByLabel(/Remember this device/i).check();
    await page.getByRole('button', { name: /Sign In/i }).click();
    await expect(page).not.toHaveURL(/\/user\/login/);
    const remember = (await context.cookies()).find((c) => c.name === 'gitea_incredible');
    expect(remember, 'remember-me cookie').toBeDefined();
    expect((remember!.expires * 1000 - Date.now()) / 86_400_000).toBeGreaterThan(364);
  });

  test('your login is a plain reviewer: no repo Settings, no site administration (ADR 0005)', async ({ page, request }) => {
    const me = await reviewerApi().req<{ login: string; is_admin: boolean }>('GET', '/user');
    expect(me).toMatchObject({ login: E2E.reviewer, is_admin: false });
    expect((await adminApi().req<{ is_admin: boolean }>('GET', '/user')).is_admin).toBe(true);
    await loginAsReviewer(page);
    await page.goto(`/${E2E.org}/guarded`);
    await expect(page.locator('a[href$="/guarded/settings"]')).toHaveCount(0);
    for (const path of [`/${E2E.org}/guarded/settings`, `/${E2E.org}/guarded/settings/branches`, '/-/admin', '/-/admin/users']) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBeGreaterThanOrEqual(403);
    }
    void request;
  });

  test('your login sees the Slipway repos: /repos lists them and "Repositories" in the top bar leads there', async ({ page }) => {
    await loginAsReviewer(page);
    const org = await page.goto(`/${E2E.org}`);
    expect(org?.status()).toBe(200);
    await expect(page.locator(`a[href="/${E2E.org}/guarded"]`).first()).toBeVisible();
    await page.goto('/pulls');
    await page.locator('#navbar').getByRole('link', { name: 'Repositories', exact: true }).click();
    await expect(page.locator(`a[href="/${E2E.org}/guarded"]`).first()).toBeVisible();
    // Still no repo admin rights.
    expect((await page.goto(`/${E2E.org}/guarded/settings`))?.status()).toBe(404);
  });

  test('setup is idempotent and keeps the owner token and the enrolled Claude', async () => {
    const before = config();
    const again = await slipway(['setup']);
    expect(again.code, again.stderr).toBe(0);
    const after = config();
    expect(after.reviewer.token).toBe(before.reviewer.token);
    expect(after.admin.token).toBe(before.admin.token);
    expect(after.claude).toEqual(before.claude);
    expect(Object.keys(after.repos)).toEqual(Object.keys(before.repos));
  });

  test('config never contains a GitHub token', async () => {
    expect(JSON.stringify(config())).not.toContain(E2E.githubToken);
  });
});
