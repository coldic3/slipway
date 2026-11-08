import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SLIPWAY_ROOT } from '../../src/paths.ts';
import { VERSION } from '../../src/version.ts';

const json = (p: string) => JSON.parse(readFileSync(join(SLIPWAY_ROOT, p), 'utf8'));

describe('one version everywhere', () => {
  it('package.json, the plugin and the marketplace entry agree', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(json('package.json').version).toBe(VERSION);
    expect(json('plugin/.claude-plugin/plugin.json').version).toBe(VERSION);
    expect(json('.claude-plugin/marketplace.json').plugins[0].version).toBe(VERSION);
  });

  it('the Gitea image of the Docker runtime matches the pinned native Gitea', async () => {
    const { GITEA_VERSION } = await import('../../src/runtime/downloads.ts');
    expect(readFileSync(join(SLIPWAY_ROOT, 'docker', 'compose.yaml'), 'utf8')).toContain(`gitea/gitea:${GITEA_VERSION}-rootless`);
  });
});
