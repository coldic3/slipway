import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { startTaskWorktree } from '../../src/mcp/start-task.ts';
import { git } from '../../src/util/exec.ts';
import { AGENT, identityEnv, makeFixture, type Fixture } from '../helpers/git-fixture.ts';

describe('startTaskWorktree (slipway_start_task, I-1)', () => {
  let f: Fixture;
  beforeEach(async () => { f = await makeFixture(); });

  it('creates the worktree INSIDE the project on agent/<id>-<slug> from origin/<base>, git-excluded', async () => {
    const r = await startTaskWorktree({ repoDir: f.clone, base: 'main', taskId: '12', slug: 'add-parser', env: identityEnv(AGENT) });
    expect(r.path).toBe(join(f.clone, '.slipway', 'worktrees', '12-add-parser'));
    expect(await git(r.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('agent/12-add-parser');
    expect(await git(r.path, ['rev-parse', 'HEAD'])).toBe(await git(f.clone, ['rev-parse', 'origin/main']));
    expect(readFileSync(join(f.clone, '.git', 'info', 'exclude'), 'utf8')).toContain('/.slipway/');
    expect(await git(f.clone, ['status', '--porcelain'])).toBe('');
  });

  it('is idempotent for an existing task worktree and rejects unsafe names', async () => {
    const a = await startTaskWorktree({ repoDir: f.clone, base: 'main', taskId: '12', slug: 'x', env: identityEnv(AGENT) });
    const b = await startTaskWorktree({ repoDir: f.clone, base: 'main', taskId: '12', slug: 'x', env: identityEnv(AGENT) });
    expect(b.path).toBe(a.path);
    expect(b.existed).toBe(true);
    await expect(startTaskWorktree({ repoDir: f.clone, base: 'main', taskId: '1', slug: 'bad slug', env: identityEnv(AGENT) })).rejects.toThrow(/slug/);
  });

  it('uses the branch name the repo conventions ask for, and reuses the worktree on it (ADR 0010)', async () => {
    const r = await startTaskWorktree({ repoDir: f.clone, base: 'main', taskId: 'DRY-7', slug: 'login', branch: 'feature/DRY-7-login', env: identityEnv(AGENT) });
    expect(r.branch).toBe('feature/DRY-7-login');
    expect(await git(r.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feature/DRY-7-login');
    const again = await startTaskWorktree({ repoDir: f.clone, base: 'main', taskId: 'DRY-7', slug: 'login', env: identityEnv(AGENT) });
    expect(again).toEqual({ path: r.path, branch: 'feature/DRY-7-login', existed: true });
  });

  it('rejects invalid branch names and the base branch', async () => {
    await expect(startTaskWorktree({ repoDir: f.clone, base: 'main', taskId: '1', slug: 'a', branch: 'bad name..x', env: identityEnv(AGENT) })).rejects.toThrow(/not a valid git branch name/);
    await expect(startTaskWorktree({ repoDir: f.clone, base: 'main', taskId: '1', slug: 'b', branch: 'main', env: identityEnv(AGENT) })).rejects.toThrow(/base branch/);
  });
});
