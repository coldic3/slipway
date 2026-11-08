import { afterEach, describe, expect, it } from 'vitest';
import { githubToken } from '../../src/promote/github-token.ts';

describe('githubToken', () => {
  const prev = process.env.SLIPWAY_GITHUB_TOKEN;
  afterEach(() => { if (prev === undefined) delete process.env.SLIPWAY_GITHUB_TOKEN; else process.env.SLIPWAY_GITHUB_TOKEN = prev; });

  it('prefers SLIPWAY_GITHUB_TOKEN', async () => {
    process.env.SLIPWAY_GITHUB_TOKEN = 'env-tok';
    expect(await githubToken(async () => ({ code: 0, stdout: 'gh-tok\n', stderr: '' }))).toBe('env-tok');
  });
  it('falls back to gh auth token', async () => {
    delete process.env.SLIPWAY_GITHUB_TOKEN;
    const calls: string[][] = [];
    expect(await githubToken(async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: 'gh-tok\n', stderr: '' }; })).toBe('gh-tok');
    expect(calls).toEqual([['gh', 'auth', 'token']]);
  });
  it('explains a missing gh', async () => {
    delete process.env.SLIPWAY_GITHUB_TOKEN;
    await expect(githubToken(async () => ({ code: 127, stdout: '', stderr: '' }))).rejects.toThrow(/GitHub CLI \(gh\) is not installed/);
  });
  it('explains a logged-out gh', async () => {
    delete process.env.SLIPWAY_GITHUB_TOKEN;
    await expect(githubToken(async () => ({ code: 1, stdout: '', stderr: 'no oauth token' }))).rejects.toThrow(/gh auth login/);
  });
});
