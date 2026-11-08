import { expect, test, type Page } from '@playwright/test';
import { E2E } from './helpers/env.ts';
import { claudeStartsTask, loginAsReviewer, makeRepo } from './helpers/slipway.ts';
import { FakeClaude } from './helpers/mcp.ts';

/** Visible text of the page, without scripts/styles. */
const visibleText = (page: Page) => page.evaluate(() => document.body.innerText);

test.describe('Slipway branding (no stock Gitea look)', () => {
  test('signed-out visitors see the Slipway sign-in page, in English, with no trace of Gitea', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/user\/login/);
    await expect(page).toHaveTitle(/Slipway/);
    expect(await page.title()).not.toMatch(/gitea/i);
    const text = await visibleText(page);
    expect(text).toContain('Slipway');
    expect(text).toContain('Review AI pull requests, then launch them to GitHub');
    expect(text).not.toMatch(/gitea/i);
    expect(text).not.toMatch(/powered by/i);
    await expect(page.locator('img[src*="logo"]').first()).toHaveAttribute('src', /assets\/img\/logo\.svg/);
    // Nothing Slipway can't do: no password reset (no mail), no passkeys, no duplicate sign-in link in the top bar.
    expect(text).not.toMatch(/forgot password|passkey/i);
    await expect(page.locator('#navbar a[href$="/user/login"]')).toBeHidden();
    await expect(page.locator('.signin-passkey')).toHaveCount(0); // not rendered at all (no empty frame)
    // Only English is offered.
    await expect(page.getByText(/^(Polski|Deutsch|Français|简体中文)$/)).toHaveCount(0);
  });

  test('dark mode is neutral gray (not navy) with readable text', async ({ page }) => {
    await page.goto('/user/login');
    const colors = await page.evaluate(() => {
      const parse = (c: string) => c.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
      const css = (el: Element, prop: string) => parse(getComputedStyle(el).getPropertyValue(prop));
      const box = document.querySelector('.slipway-signin .ui.attached.segment')!;
      return { body: css(document.body, 'background-color'), box: css(box, 'background-color'), label: css(document.querySelector('label[for="user_name"]')!, 'color') };
    });
    const spread = ([r, g, b]: number[]) => Math.max(r!, g!, b!) - Math.min(r!, g!, b!);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    for (const c of [colors.body, colors.box]) {
      expect(spread(c), `background ${c} should be gray, not tinted`).toBeLessThanOrEqual(10);
      expect(lum(c)).toBeLessThan(0.05); // still dark mode
    }
    const contrast = (lum(colors.label) + 0.05) / (lum(colors.box) + 0.05);
    expect(contrast, 'label text contrast on the form').toBeGreaterThanOrEqual(7); // WCAG AAA
  });

  test('the logo and favicon are Slipway’s', async ({ request }) => {
    const logo = await (await request.get('/assets/img/logo.svg')).text();
    expect(logo).toContain('slipway-logo');
    const favicon = await (await request.get('/assets/img/favicon.svg')).text();
    expect(favicon).toContain('slipway-logo');
    expect((await request.get('/assets/img/favicon.png')).status()).toBe(200);
  });

  test('after sign-in: Slipway PR list, trimmed navigation, PR page without Gitea or merge box', async ({ page }) => {
    const repo = await makeRepo('branded');
    const wt = await claudeStartsTask(repo, { branch: 'agent/9-brand', file: 'b.txt', content: 'b\n', message: 'Add b' });
    const claude = await FakeClaude.start(wt);
    let pr: number;
    try {
      pr = Number(/PR #(\d+)/.exec(await claude.ok('slipway_open_pr', { cwd: wt, title: 'Add b', body: 'b' }))![1]);
    } finally {
      await claude.close();
    }
    await loginAsReviewer(page);

    // Landing page = open Slipway PRs across repos.
    await page.goto('/');
    await expect(page).toHaveURL(/\/pulls/);
    await expect(page.getByText('Add b').first()).toBeVisible();

    const nav = page.locator('#navbar');
    await expect(nav.getByRole('link', { name: 'Pull requests', exact: false }).first()).toBeVisible();
    for (const hidden of ['Explore', 'Issues', 'Milestones']) await expect(nav.getByRole('link', { name: hidden, exact: true })).toHaveCount(0);

    await page.goto(`/${E2E.org}/branded/pulls/${pr}`);
    const text = await visibleText(page);
    expect(text).not.toMatch(/gitea/i);
    expect(text).toContain('Approved PRs are promoted to GitHub from your Claude session');
    const repoTabs = page.locator('.overflow-menu-items, .secondary-nav');
    for (const tab of ['Issues', 'Wiki', 'Projects', 'Releases', 'Packages', 'Actions']) {
      await expect(repoTabs.getByRole('link', { name: new RegExp(`^${tab}`) })).toHaveCount(0);
    }
    for (const btn of ['Watch', 'Star', 'Fork']) await expect(page.getByRole('button', { name: new RegExp(`^${btn}`) })).toHaveCount(0);
    await expect(page.locator('a[href$="/-/fork"], a[href*="/action/star"]')).toHaveCount(0);

    // Avatars come from Gravatar by e-mail (identicon fallback), never Gitea's default picture (ADR 0001).
    await page.goto(`/${E2E.org}/branded/pulls/${pr}/commits`);
    const avatars = await page.locator('img.avatar').evaluateAll((els) => els.map((e) => e.getAttribute('src') ?? ''));
    expect(avatars.length).toBeGreaterThan(0);
    for (const src of avatars) expect(src).toMatch(/^https:\/\/secure\.gravatar\.com\/avatar\/[0-9a-f]+\?d=identicon/);
  });
});
