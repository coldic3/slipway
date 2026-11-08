import { describe, expect, it } from 'vitest';
import { gitleaksAvailable, scanSecrets } from '../../src/promote/secrets.ts';
import { git } from '../../src/util/exec.ts';
import { agentCommit, makeFixture } from '../helpers/git-fixture.ts';

const available = await gitleaksAvailable();

describe('scanSecrets', () => {
  it.skipIf(!available)('finds a planted AWS key in the promoted range and redacts it', async () => {
    const f = await makeFixture();
    await agentCommit(f, 'agent/1-x', 'clean.txt', 'nothing here\n', 'Clean');
    const key = 'AKIA' + 'Z7XQ3MPLR2VBN4TD';
    await agentCommit(f, 'agent/1-x', 'config.env', `AWS_ACCESS_KEY_ID=${key}\n`, 'Add config');
    const base = await git(f.agent, ['rev-parse', 'origin/main']);
    const head = await git(f.agent, ['rev-parse', 'HEAD']);
    const r = await scanSecrets(f.agent, `${base}..${head}`);
    expect(r.ok).toBe(false);
    expect(r.findings).toContainEqual(expect.objectContaining({ rule: 'aws-access-token', file: 'config.env', line: 1 }));
    expect(JSON.stringify(r)).not.toContain(key);
  });

  it.skipIf(!available)('passes a clean range', async () => {
    const f = await makeFixture();
    await agentCommit(f, 'agent/1-x', 'clean.txt', 'nothing here\n', 'Clean');
    const base = await git(f.agent, ['rev-parse', 'origin/main']);
    const r = await scanSecrets(f.agent, `${base}..HEAD`);
    expect(r).toEqual({ ok: true, findings: [] });
  });

  it('fails closed when no scanner can run', async () => {
    const r = await scanSecrets('/tmp', 'a..b', async () => ({ code: 127, stdout: '', stderr: 'not found' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/gitleaks/);
  });

  it('fails closed on scanner errors (exit code other than 0/1)', async () => {
    const r = await scanSecrets('/tmp', 'a..b', async (cmd) => (cmd === 'gitleaks' ? { code: 2, stdout: '', stderr: 'bad repo' } : { code: 127, stdout: '', stderr: '' }));
    expect(r.ok).toBe(false);
  });

  it('uses the gitleaks that slipway up downloaded when none is on PATH', async () => {
    const calls: string[] = [];
    const r = await scanSecrets('/tmp', 'a..b', async (cmd) => {
      calls.push(cmd);
      return cmd === 'gitleaks' ? { code: 127, stdout: '', stderr: '' } : { code: 0, stdout: '[]', stderr: '' };
    }, '/bin/sh');
    expect(calls).toEqual(['gitleaks', '/bin/sh']);
    expect(r).toEqual({ ok: true, findings: [] });
  });
});
