import { slipwayEnv } from '../env.ts';
import { parseArgs } from 'node:util';
import { loadConfig, type Account } from '../config.ts';
import { GiteaClient } from '../gitea/client.ts';
import { GitHubClient } from '../github/client.ts';
import { prepareBranch, pushToOrigin } from './git.ts';
import { githubOriginAuth, promote, runShell, type PromoteDeps, type PromoteOptions } from './promote.ts';
import { githubToken } from './github-token.ts';
import { scanSecrets } from './secrets.ts';

export function githubApiBase(): string {
  return slipwayEnv('GITHUB_API') || 'https://api.github.com';
}

/** Production wiring. `actor` is the Gitea account doing the work (Slipway's technical admin from the CLI, Claude's user from the plugin). */
export function defaultPromoteDeps(log: (m: string) => void, token: string, actor?: Account): PromoteDeps {
  const config = loadConfig();
  const who = actor ?? config.admin;
  return {
    config,
    githubToken: token,
    actor: who,
    gitea: new GiteaClient(config.giteaUrl, who.token),
    github: new GitHubClient(githubApiBase(), token),
    prepare: prepareBranch,
    push: pushToOrigin,
    scan: (dir, range) => scanSecrets(dir, range),
    runTests: runShell,
    originAuth: (dir) => githubOriginAuth(dir, token),
    log,
  };
}

/** Parses promote flags (CLI). */
export function parsePromoteFlags(args: string[]): Omit<PromoteOptions, 'repo' | 'pr'> & { positionals: string[] } {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      draft: { type: 'boolean' },
      base: { type: 'string' },
      'test-cmd': { type: 'string' },
      force: { type: 'boolean' },
    },
  });
  return {
    positionals,
    draft: !!values.draft,
    base: values.base,
    testCmd: values['test-cmd'] ?? slipwayEnv('TEST_CMD') ?? undefined,
    force: !!values.force,
  };
}

export async function runPromoteCli(args: string[], log: (m: string) => void): Promise<number> {
  const { positionals, ...flags } = parsePromoteFlags(args);
  const [repo, prStr] = positionals;
  const pr = Number(prStr);
  if (!repo || !Number.isInteger(pr)) throw new Error('usage: slipway promote <repo> <pr-number> [flags]');
  let token = '';
  try {
    token = await githubToken();
  } catch (e) {
    log((e as Error).message);
    return 1;
  }
  const r = await promote({ repo, pr, ...flags }, defaultPromoteDeps(log, token));
  if (r.code === 5) log('(to promote anyway, add --force)');
  if (r.url) console.log(r.url);
  return r.code;
}
