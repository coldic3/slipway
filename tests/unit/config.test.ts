import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { slipwayHome, loadConfig, saveConfig, type SlipwayConfig } from '../../src/config.ts';

const sample: SlipwayConfig = {
  giteaUrl: 'http://127.0.0.1:3000',
  admin: { username: 'admin', password: 'x', token: 'ta' },
  reviewer: { username: 'slipway', password: 'slipway', token: 'tr' },
  org: 'repos',
  claude: { username: 'claude-mac', password: 'pw2', token: 't2' },
  repos: { demo: { path: '/tmp/demo', base: 'main', github: 'kevin/demo' } },
};

describe('config', () => {
  const prev = process.env.SLIPWAY_HOME;
  beforeEach(() => { process.env.SLIPWAY_HOME = mkdtempSync(join(tmpdir(), 'dd-home-')); });
  afterEach(() => { process.env.SLIPWAY_HOME = prev; });

  it('round-trips and writes the file with mode 0600', () => {
    saveConfig(sample);
    expect(loadConfig()).toEqual(sample);
    expect(statSync(join(slipwayHome(), 'config.json')).mode & 0o777).toBe(0o600);
  });

  it('throws a helpful error when not set up', () => {
    expect(() => loadConfig()).toThrow(/slipway init/);
  });
});
