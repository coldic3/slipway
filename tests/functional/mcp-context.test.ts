import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SlipwayConfig } from '../../src/config.ts';
import { NotRegisteredError, resolveRepo } from '../../src/mcp/context.ts';
import { git } from '../../src/util/exec.ts';
import { HUMAN, identityEnv, makeFixture, type Fixture } from '../helpers/git-fixture.ts';

describe('resolveRepo', () => {
  let f: Fixture;
  let config: SlipwayConfig;
  beforeEach(async () => {
    f = await makeFixture();
    config = { giteaUrl: 'http://g', admin: { username: 'admin', password: 'a', token: 'ta' }, reviewer: { username: 'slipway', password: 'p', token: 't' }, org: 'repos', repos: { demo: { path: f.clone, base: 'main', github: 'kevin/demo' } } };
  });

  it('from the main clone', async () => {
    const r = await resolveRepo(f.clone, config);
    expect(r).toMatchObject({ name: 'demo', branch: 'main' });
  });

  it('from a git worktree of the clone (Review Focus 1), with its branch', async () => {
    const wt = join(f.root, 'wt-1');
    await git(f.clone, ['worktree', 'add', '-q', '-b', 'agent/1-x', wt, 'origin/main'], identityEnv(HUMAN));
    const r = await resolveRepo(join(wt), config);
    expect(r).toMatchObject({ name: 'demo', branch: 'agent/1-x' });
    expect(r.worktree.endsWith('wt-1')).toBe(true);
  });

  it('detached HEAD → branch null', async () => {
    await git(f.clone, ['checkout', '-q', '--detach'], identityEnv(HUMAN));
    expect((await resolveRepo(f.clone, config)).branch).toBeNull();
  });

  it('not registered → NotRegisteredError with the repo add hint', async () => {
    const other = mkdtempSync(join(tmpdir(), 'dd-other-'));
    await git(other, ['init', '-q'], identityEnv(HUMAN));
    await expect(resolveRepo(other, config)).rejects.toThrow(NotRegisteredError);
    await expect(resolveRepo(other, config)).rejects.toThrow(/slipway repo add/);
    await expect(resolveRepo(other, { ...config, sandbox: 'sb' })).rejects.toThrow(/on the host: .*then slipway sbx setup sb/);
  });

  it('not a git repo → NotRegisteredError', async () => {
    await expect(resolveRepo(mkdtempSync(join(tmpdir(), 'dd-nogit-')), config)).rejects.toThrow(NotRegisteredError);
  });
});
