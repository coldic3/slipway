import { afterEach, describe, expect, it } from 'vitest';
import { claudeCode, marketplaceSource } from '../../src/agents/index.ts';
import type { ExecResult } from '../../src/util/exec.ts';

type Reply = Partial<ExecResult>;
function runner(replies: Record<string, Reply>) {
  const calls: string[] = [];
  const fn = async (cmd: string, args: string[]): Promise<ExecResult> => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    const key = Object.keys(replies).find((k) => line.startsWith(k));
    return { code: 0, stdout: '', stderr: '', ...(key ? replies[key] : {}) };
  };
  return { fn, calls };
}

describe('Claude Code integration', () => {
  afterEach(() => { delete process.env.SLIPWAY_MARKETPLACE; });

  it('adds the GitHub marketplace (sparse: only the plugin) and installs slipway@slipway', async () => {
    const r = runner({});
    expect(await claudeCode.install(() => {}, r.fn)).toEqual({ done: true });
    expect(r.calls).toEqual([
      'claude --version',
      'claude plugin marketplace add coldic3/slipway --sparse .claude-plugin plugin',
      'claude plugin install slipway@slipway',
    ]);
  });

  it('updates instead when the marketplace and plugin are already there', async () => {
    const r = runner({ 'claude plugin marketplace add': { code: 1, stderr: 'Marketplace already exists' }, 'claude plugin install': { code: 1, stderr: 'already installed' } });
    expect(await claudeCode.install(() => {}, r.fn)).toEqual({ done: true });
    expect(r.calls).toContain('claude plugin marketplace update slipway');
    expect(r.calls).toContain('claude plugin update slipway@slipway');
  });

  it('without the claude CLI it returns the /plugin commands to run by hand', async () => {
    const r = runner({ 'claude --version': { code: 127 } });
    expect(await claudeCode.install(() => {}, r.fn)).toEqual({ done: false, manual: ['/plugin marketplace add coldic3/slipway', '/plugin install slipway@slipway'] });
  });

  it('SLIPWAY_MARKETPLACE points at a local checkout (no sparse checkout)', async () => {
    process.env.SLIPWAY_MARKETPLACE = '/src/slipway';
    expect(marketplaceSource()).toBe('/src/slipway');
    const r = runner({});
    await claudeCode.install(() => {}, r.fn);
    expect(r.calls[1]).toBe('claude plugin marketplace add /src/slipway');
  });
});
