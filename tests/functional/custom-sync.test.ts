import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHIPPED_CUSTOM, syncCustom, treeDigest } from '../../src/runtime/custom.ts';

describe('syncCustom', () => {
  it('copies the shipped branding and reports no change on the next sync', () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'sw-custom-')), 'custom');
    expect(syncCustom(dest)).toBe(true);
    expect(treeDigest(dest)).toBe(treeDigest(SHIPPED_CUSTOM));
    expect(syncCustom(dest)).toBe(false);
  });

  it('replaces the contents in place, so a Docker bind mount of the directory sees the update', () => {
    const root = mkdtempSync(join(tmpdir(), 'sw-custom-'));
    const source = join(root, 'source');
    const dest = join(root, 'dest');
    mkdirSync(join(source, 'templates'), { recursive: true });
    writeFileSync(join(source, 'templates', 'a.tmpl'), 'new');
    mkdirSync(join(dest, 'public'), { recursive: true });
    writeFileSync(join(dest, 'public', 'stale.css'), 'old');
    const inode = statSync(dest).ino;

    expect(syncCustom(dest, source)).toBe(true);
    expect(statSync(dest).ino).toBe(inode);
    expect(readFileSync(join(dest, 'templates', 'a.tmpl'), 'utf8')).toBe('new');
    expect(existsSync(join(dest, 'public'))).toBe(false);

    writeFileSync(join(source, 'templates', 'a.tmpl'), 'newer');
    expect(syncCustom(dest, source)).toBe(true);
    expect(readFileSync(join(dest, 'templates', 'a.tmpl'), 'utf8')).toBe('newer');
  });
});
