// Renders the Slipway SVG logo/favicon to the PNG sizes Gitea serves (favicon.png, logo.png, apple-touch-icon.png).
// Usage: node scripts/build-brand.mjs   (uses Playwright's Chromium, already a dev dependency)
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const img = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'gitea', 'public', 'assets', 'img');
const targets = [
  ['favicon.svg', 'favicon.png', 180],
  ['logo.svg', 'logo.png', 512],
  ['favicon.svg', 'apple-touch-icon.png', 180],
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [src, out, size] of targets) {
  const svg = readFileSync(join(img, src), 'utf8');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace(/width="64" height="64"/, `width="${size}" height="${size}"`)}</body></html>`);
  await page.locator('svg').screenshot({ path: join(img, out), omitBackground: true });
}
await browser.close();
