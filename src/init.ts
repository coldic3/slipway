import { createInterface } from 'node:readline/promises';
import { AGENTS, agentById, type AgentIntegration, type InstallResult } from './agents/index.ts';
import type { SlipwayConfig } from './config.ts';
import { parsePort, type Instance, type RuntimeKind } from './instance.ts';
import { PortBusyError } from './runtime/port.ts';
import { run } from './util/exec.ts';
import { parseGitHubRemote } from './util/git-auth.ts';

/** Asks one question; returns the trimmed answer ('' = Enter). */
export type Ask = (question: string) => Promise<string>;

export interface InitOptions {
  /** claude-code | none; asked when missing on a terminal. */
  agent?: string;
  port?: string;
  docker?: boolean;
  /** Never ask: defaults everywhere (also without a terminal). */
  yes?: boolean;
}

export interface InitDeps {
  /** undefined = non-interactive. */
  ask?: Ask;
  log: (m: string) => void;
  up: (o: { port?: string | number; runtime?: RuntimeKind; log: (m: string) => void }) => Promise<Instance>;
  setup: (log: (m: string) => void) => Promise<SlipwayConfig>;
  addRepo: (path: string, log: (m: string) => void) => Promise<{ name: string }>;
  /** The top of the git clone at cwd when it has a GitHub origin and is not registered yet. */
  repoHere: (config: SlipwayConfig) => Promise<string | undefined>;
  ghLoggedIn: () => Promise<boolean>;
  agents?: AgentIntegration[];
}

const NONE = 'none';

export async function chooseAgent(opts: InitOptions, ask: Ask | undefined, agents: AgentIntegration[]): Promise<AgentIntegration | undefined> {
  if (opts.agent) {
    if (opts.agent === NONE) return undefined;
    const a = agents.find((x) => x.id === opts.agent);
    if (!a) throw new Error(`unknown agent "${opts.agent}": use ${[...agents.map((x) => x.id), NONE].join(', ')}`);
    return a;
  }
  if (!ask) return agents[0];
  const menu = [...agents.map((a, i) => `  ${i + 1}) ${a.label}`), `  ${agents.length + 1}) None for now (only the review server)`].join('\n');
  for (;;) {
    const answer = await ask(`Which AI agent should open PRs through Slipway?\n${menu}\nChoose [1]: `);
    const n = answer === '' ? 1 : Number(answer);
    if (n >= 1 && n <= agents.length) return agents[n - 1];
    if (n === agents.length + 1) return undefined;
    const byName = agents.find((a) => a.id === answer.toLowerCase() || a.label.toLowerCase() === answer.toLowerCase());
    if (byName) return byName;
  }
}

/** Busy port on a terminal: offer the suggested free port, or let the user type one. */
export async function askPort(e: PortBusyError, ask: Ask): Promise<number> {
  for (;;) {
    const q = e.suggestion
      ? `Port ${e.port} is already used by another program. Use ${e.suggestion} instead? [Y/n, or type a port]: `
      : `Port ${e.port} is already used by another program. Which port should Slipway use? `;
    const a = (await ask(q)).toLowerCase();
    if (e.suggestion && (a === '' || a === 'y' || a === 'yes')) return e.suggestion;
    if (a === 'n' || a === 'no') throw new Error('Slipway needs a free port; run slipway init --port <port> when you have one');
    try {
      return parsePort(a);
    } catch (err) {
      if (a) process.stderr.write(`${(err as Error).message}\n`);
    }
  }
}

const yes = (a: string) => a === '' || /^y(es)?$/i.test(a);

/** `slipway init` (ADR 0011): server, logins, the agent's integration and optionally this repo, in one go. */
export async function init(opts: InitOptions, d: InitDeps): Promise<{ config: SlipwayConfig; instance: Instance; agent?: AgentIntegration; install?: InstallResult; repo?: string }> {
  const ask = opts.yes ? undefined : d.ask;
  const agents = d.agents ?? AGENTS;
  const agent = await chooseAgent(opts, ask, agents);

  let port: string | number | undefined = opts.port;
  let instance: Instance;
  for (;;) {
    try {
      instance = await d.up({ port, runtime: opts.docker ? 'docker' : undefined, log: d.log });
      break;
    } catch (e) {
      if (!(e instanceof PortBusyError) || !ask) throw e;
      port = await askPort(e, ask);
    }
  }

  const config = await d.setup(d.log);

  let install: InstallResult | undefined;
  if (agent) install = await agent.install(d.log);

  let repo: string | undefined;
  const here = await d.repoHere(config);
  if (here && ask && yes(await ask(`Register ${here} for review in Slipway? [Y/n]: `))) {
    repo = (await d.addRepo(here, d.log)).name;
  }

  if (!(await d.ghLoggedIn())) d.log('warning: the GitHub CLI is not logged in; promotion to GitHub needs it: gh auth login');
  return { config, instance: instance!, agent, install, repo };
}

export function initSummary(r: Awaited<ReturnType<typeof init>>, here?: string): string {
  const lines = [
    '',
    `Slipway is ready: ${r.config.giteaUrl}`,
    `  login: ${r.config.reviewer.username} / ${r.config.reviewer.password}  (tick "Remember this device")`,
  ];
  if (r.agent && r.install?.done) lines.push(`  ${r.agent.label}: plugin installed (restart running sessions to load it)`);
  if (r.agent && r.install && !r.install.done) lines.push(`  ${r.agent.label}: finish in ${r.agent.label}:`, ...r.install.manual!.map((m) => `    ${m}`));
  if (r.repo) lines.push(`  repo registered: ${r.repo}`);
  else lines.push(`  next: slipway repo add ${here ?? '<path-to-your-clone>'}`);
  if (r.agent) lines.push('', `Then tell ${r.agent.label}: "Implement X and open a Slipway PR".`);
  return lines.join('\n');
}

/** Terminal prompts on stderr (stdout stays clean for scripts). */
export function terminalAsk(): { ask: Ask; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return { ask: async (q) => (await rl.question(q)).trim(), close: () => rl.close() };
}

export async function repoHere(config: SlipwayConfig, cwd = process.cwd()): Promise<string | undefined> {
  const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (top.code !== 0) return undefined;
  const path = top.stdout.trim();
  if (Object.values(config.repos).some((r) => r.path === path)) return undefined;
  const origin = await run('git', ['remote', 'get-url', 'origin'], { cwd: path });
  return origin.code === 0 && parseGitHubRemote(origin.stdout) ? path : undefined;
}

export async function ghLoggedIn(): Promise<boolean> {
  return (await run('gh', ['auth', 'status'])).code === 0;
}

export { agentById };
