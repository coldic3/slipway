import { slipwayEnv } from '../env.ts';
import { run, type ExecResult } from '../util/exec.ts';

export type Runner = (cmd: string, args: string[]) => Promise<ExecResult>;
const defaultRunner: Runner = (cmd, args) => run(cmd, args, { timeoutMs: 300_000 });

export interface InstallResult {
  /** True when the agent is wired up; false when the user has to finish by hand (`manual`). */
  done: boolean;
  manual?: string[];
}

/** An AI agent Slipway can be set up for (ADR 0011). Only Claude Code exists today; others plug in here. */
export interface AgentIntegration {
  id: string;
  label: string;
  install(log: (m: string) => void, runner?: Runner): Promise<InstallResult>;
}

export const GITHUB_REPO = 'coldic3/slipway';

/** Marketplace source for the plugin: SLIPWAY_MARKETPLACE (e.g. a local checkout), else this GitHub repo. */
export function marketplaceSource(): string {
  return slipwayEnv('MARKETPLACE') || GITHUB_REPO;
}

const isRemote = (source: string) => /^[\w.-]+\/[\w.-]+$/.test(source) || /^(https?|git@)/.test(source);
const already = (r: ExecResult) => /already/i.test(r.stdout + r.stderr);

export const claudeCode: AgentIntegration = {
  id: 'claude-code',
  label: 'Claude Code',
  async install(log, runner = defaultRunner) {
    const source = marketplaceSource();
    const manual = [`/plugin marketplace add ${source}`, '/plugin install slipway@slipway'];
    if ((await runner('claude', ['--version'])).code !== 0) return { done: false, manual };

    log(`adding the Slipway plugin marketplace (${source})`);
    // From GitHub, check out only what the plugin needs.
    const add = await runner('claude', ['plugin', 'marketplace', 'add', source, ...(isRemote(source) ? ['--sparse', '.claude-plugin', 'plugin'] : [])]);
    if (add.code !== 0) {
      if (!already(add)) return { done: false, manual: [`(claude plugin marketplace add failed: ${(add.stderr || add.stdout).trim()})`, ...manual] };
      await runner('claude', ['plugin', 'marketplace', 'update', 'slipway']);
    }
    log('installing the plugin slipway@slipway');
    const inst = await runner('claude', ['plugin', 'install', 'slipway@slipway']);
    if (inst.code !== 0) {
      if (!already(inst)) return { done: false, manual: [`(claude plugin install failed: ${(inst.stderr || inst.stdout).trim()})`, ...manual.slice(1)] };
      await runner('claude', ['plugin', 'update', 'slipway@slipway']);
    }
    return { done: true };
  },
};

export const AGENTS: AgentIntegration[] = [claudeCode];

export function agentById(id: string): AgentIntegration | undefined {
  return AGENTS.find((a) => a.id === id);
}
