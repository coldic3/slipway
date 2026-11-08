import { describe, expect, it, vi } from 'vitest';
import type { SlipwayConfig } from '../../src/config.ts';
import { GiteaError } from '../../src/gitea/client.ts';
import { claudeUsername, ensureClaudeUser, resetEnrollmentCache, type GiteaAdminPort } from '../../src/mcp/enroll.ts';

const baseConfig = (): SlipwayConfig => ({
  giteaUrl: 'http://g', admin: { username: 'admin', password: 'a', token: 'at' }, reviewer: { username: 'slipway', password: 'p', token: 'ot' }, org: 'repos',
  repos: { a: { path: '/a', base: 'main', github: 'k/a' }, b: { path: '/b', base: 'main', github: 'k/b' } },
});

function admin(over: Partial<Record<keyof GiteaAdminPort, any>> = {}) {
  return {
    createUser: vi.fn(async () => {}),
    resetPassword: vi.fn(async () => {}),
    createToken: vi.fn(async () => 'claude-token'),
    addCollaborator: vi.fn(async () => {}),
    ...over,
  };
}

describe('claudeUsername', () => {
  it('derives a Gitea-safe name from the hostname', () => {
    expect(claudeUsername('Kevin’s MacBook.local')).toBe('claude-kevin-s-macbook-local');
    expect(claudeUsername('x'.repeat(80)).length).toBeLessThanOrEqual(40);
    expect(claudeUsername('host', 'my-claude')).toBe('my-claude');
  });
});

describe('ensureClaudeUser', () => {
  it('creates user + token, grants write on every registered repo, saves the config', async () => {
    resetEnrollmentCache();
    const a = admin();
    const saved: SlipwayConfig[] = [];
    const acc = await ensureClaudeUser(baseConfig(), { admin: a, save: (c) => saved.push(c), username: 'claude-mac' });
    expect(acc).toMatchObject({ username: 'claude-mac', token: 'claude-token' });
    expect(a.createUser).toHaveBeenCalledWith('claude-mac', 'claude-mac@slipway.local', expect.any(String));
    expect(a.addCollaborator.mock.calls.map((c: unknown[]) => [c[0], c[1]])).toEqual([['repos', 'a'], ['repos', 'b']]);
    expect(saved[0]!.claude).toEqual(acc);
  });

  it('returns the saved identity without calling Gitea', async () => {
    resetEnrollmentCache();
    const a = admin();
    const config = { ...baseConfig(), claude: { username: 'claude-mac', password: 'x', token: 'saved' } };
    expect((await ensureClaudeUser(config, { admin: a, save: () => {}, username: 'claude-mac' })).token).toBe('saved');
    expect(a.createUser).not.toHaveBeenCalled();
  });

  it('concurrent first calls create the user once (Review Focus 5)', async () => {
    resetEnrollmentCache();
    const a = admin();
    const deps = { admin: a, save: () => {}, username: 'claude-mac' };
    const config = baseConfig();
    const [x, y] = await Promise.all([ensureClaudeUser(config, deps), ensureClaudeUser(config, deps)]);
    expect(x).toEqual(y);
    expect(a.createUser).toHaveBeenCalledTimes(1);
  });

  it('existing Gitea user (e.g. config was reset) → password reset, then token', async () => {
    resetEnrollmentCache();
    const a = admin({ createUser: vi.fn(async () => { throw new GiteaError(422, 'POST', '/admin/users', 'user already exists'); }) });
    const acc = await ensureClaudeUser(baseConfig(), { admin: a, save: () => {}, username: 'claude-mac' });
    expect(a.resetPassword).toHaveBeenCalledWith('claude-mac', acc.password);
    expect(acc.token).toBe('claude-token');
  });

  it('a failed enrollment is not cached', async () => {
    resetEnrollmentCache();
    const failing = admin({ createToken: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(ensureClaudeUser(baseConfig(), { admin: failing, save: () => {}, username: 'claude-mac' })).rejects.toThrow('boom');
    expect((await ensureClaudeUser(baseConfig(), { admin: admin(), save: () => {}, username: 'claude-mac' })).token).toBe('claude-token');
  });

  it('each enrollment uses its own token name, so a parallel enrollment never deletes the saved token (I-3)', async () => {
    resetEnrollmentCache();
    const a = admin();
    await ensureClaudeUser(baseConfig(), { admin: a, save: () => {}, username: 'claude-mac' });
    resetEnrollmentCache();
    await ensureClaudeUser(baseConfig(), { admin: a, save: () => {}, username: 'claude-mac' });
    const names = a.createToken.mock.calls.map((c: unknown[]) => c[2]);
    expect(new Set(names).size).toBe(2);
  });

  it('saves into a freshly re-read config (keeps repos added meanwhile) (I-3)', async () => {
    resetEnrollmentCache();
    const fresh = { ...baseConfig(), repos: { ...baseConfig().repos, added: { path: '/c', base: 'main', github: 'k/c' } } };
    const saved: SlipwayConfig[] = [];
    await ensureClaudeUser(baseConfig(), { admin: admin(), save: (c) => saved.push(c), username: 'claude-mac', reload: () => fresh });
    expect(Object.keys(saved[0]!.repos)).toEqual(['a', 'b', 'added']);
    expect(saved[0]!.claude?.username).toBe('claude-mac');
  });
});
