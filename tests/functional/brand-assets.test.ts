import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SLIPWAY_ROOT } from '../../src/paths.ts';

const custom = join(SLIPWAY_ROOT, 'gitea');
const hash = (rel: string) => createHash('sha256').update(readFileSync(join(custom, 'public', 'assets', rel))).digest('hex').slice(0, 10);
const templates = ['templates/custom/header.tmpl', 'templates/custom/footer.tmpl'].map((t) => readFileSync(join(custom, t), 'utf8')).join('\n');

describe('Slipway UI assets are cache-busted (Gitea serves them with max-age=6h)', () => {
  it.each(['css/slipway.css', 'js/slipway-head.js', 'js/slipway.js'])('%s is referenced with its current content hash (run: npm run build:brand)', (rel) => {
    const m = new RegExp(`/${rel.replace('.', '\\.')}\\?v=([0-9a-f]+)`).exec(templates);
    expect(m, `${rel} has no ?v= version in the templates`).not.toBeNull();
    expect(m![1]).toBe(hash(rel));
  });
});
