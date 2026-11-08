import { describe, expect, it, vi } from 'vitest';
import type { AgentIntegration } from '../../src/agents/index.ts';
import type { SlipwayConfig } from '../../src/config.ts';
import { askPort, chooseAgent, init, initSummary, type InitDeps } from '../../src/init.ts';
import { PortBusyError } from '../../src/runtime/port.ts';

const config: SlipwayConfig = {
  giteaUrl: 'http://127.0.0.1:3514',
  admin: { username: 'admin', password: 'x', token: 'a' },
  reviewer: { username: 'slipway', password: 'slipway', token: 'r' },
  org: 'repos',
  repos: {},
};

const claude: AgentIntegration = { id: 'claude-code', label: 'Claude Code', install: vi.fn(async () => ({ done: true })) };
const scripted = (...answers: string[]) => vi.fn(async (_q: string) => answers.shift() ?? '');

function deps(over: Partial<InitDeps> = {}): InitDeps {
  return {
    log: () => {},
    up: vi.fn(async (o) => ({ runtime: o.runtime ?? 'native', port: Number(o.port ?? 3514) })),
    setup: vi.fn(async () => config),
    addRepo: vi.fn(async () => ({ name: 'my-app' })),
    repoHere: vi.fn(async () => undefined),
    ghLoggedIn: vi.fn(async () => true),
    agents: [claude],
    ...over,
  };
}

describe('slipway init', () => {
  it('asks for the agent; Enter picks Claude Code', async () => {
    const ask = scripted('');
    expect(await chooseAgent({}, ask, [claude])).toBe(claude);
    expect(ask.mock.calls[0]![0]).toMatch(/1\) Claude Code\n\s+2\) None for now/);
  });

  it('"None" skips the agent; garbage is asked again', async () => {
    expect(await chooseAgent({}, scripted('7', '2'), [claude])).toBeUndefined();
    expect(await chooseAgent({ agent: 'none' }, undefined, [claude])).toBeUndefined();
    await expect(chooseAgent({ agent: 'cursor' }, undefined, [claude])).rejects.toThrow(/claude-code, none/);
  });

  it('runs up, setup and the agent install, and registers this repo when the user agrees', async () => {
    const d = deps({ ask: scripted('1', 'y'), repoHere: vi.fn(async () => '/code/my-app') });
    const r = await init({}, d);
    expect(d.up).toHaveBeenCalledWith(expect.objectContaining({ port: undefined, runtime: undefined }));
    expect(claude.install).toHaveBeenCalled();
    expect(d.addRepo).toHaveBeenCalledWith('/code/my-app', expect.any(Function));
    expect(r.repo).toBe('my-app');
    expect(initSummary(r)).toMatch(/Slipway is ready: http:\/\/127\.0\.0\.1:3514[\s\S]*slipway \/ slipway[\s\S]*plugin installed/);
  });

  it('a busy port: offers the next free one and retries there', async () => {
    const up = vi.fn()
      .mockRejectedValueOnce(new PortBusyError(3514, 3515))
      .mockImplementation(async (o) => ({ runtime: 'native', port: Number(o.port) }));
    const r = await init({ agent: 'none' }, deps({ ask: scripted(''), up }));
    expect(up).toHaveBeenLastCalledWith(expect.objectContaining({ port: 3515 }));
    expect(r.instance.port).toBe(3515);
  });

  it('a busy port without a terminal fails with the command to run', async () => {
    const up = vi.fn().mockRejectedValue(new PortBusyError(3514, 3515));
    await expect(init({ agent: 'none' }, deps({ up }))).rejects.toThrow(/slipway up --port 3515/);
  });

  it('askPort accepts a typed port and re-asks on nonsense', async () => {
    expect(await askPort(new PortBusyError(3514, 3515), scripted('abc', '4000'))).toBe(4000);
    await expect(askPort(new PortBusyError(3514, 3515), scripted('n'))).rejects.toThrow(/free port/);
  });

  it('--yes never asks: default agent, no repo registration, --docker passed through', async () => {
    const ask = scripted();
    const d = deps({ ask, repoHere: vi.fn(async () => '/code/my-app') });
    const r = await init({ yes: true, docker: true }, d);
    expect(ask).not.toHaveBeenCalled();
    expect(d.up).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'docker' }));
    expect(d.addRepo).not.toHaveBeenCalled();
    expect(r.agent).toBe(claude);
    expect(initSummary(r, '/code/my-app')).toContain('next: slipway repo add /code/my-app');
  });

  it('prints the manual plugin steps when the agent CLI is missing', async () => {
    const manual: AgentIntegration = { id: 'claude-code', label: 'Claude Code', install: async () => ({ done: false, manual: ['/plugin marketplace add coldic3/slipway', '/plugin install slipway@slipway'] }) };
    const r = await init({ yes: true }, deps({ agents: [manual] }));
    expect(initSummary(r)).toMatch(/finish in Claude Code:\n\s+\/plugin marketplace add coldic3\/slipway\n\s+\/plugin install slipway@slipway/);
  });

  it('warns when gh is not logged in', async () => {
    const log = vi.fn();
    await init({ yes: true, agent: 'none' }, deps({ log, ghLoggedIn: async () => false }));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/gh auth login/));
  });
});
