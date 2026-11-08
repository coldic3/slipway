import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { slipwayEnv } from './env.ts';

export interface Account {
  username: string;
  password: string;
  token: string;
}

export interface RepoEntry {
  /** Absolute path of the local clone (remotes: origin = GitHub, review = Gitea). */
  path: string;
  /** Base branch on GitHub, usually main. */
  base: string;
  /** GitHub repository as owner/name. */
  github: string;
}

export interface SlipwayConfig {
  /** URL of Gitea as seen from the host, e.g. http://127.0.0.1:3000 */
  giteaUrl: string;
  /** Technical Gitea admin (`admin`): used only by Slipway's tooling (setup, repo add, sync-main, Claude enrollment). Nobody logs in with it. */
  admin: Account;
  /** Your login (`slipway`): reviews and approves PRs. Not a Gitea admin; write access to the review repos. */
  reviewer: Account;
  /** Gitea organization that owns the review repos (managed by `admin`). */
  org: string;
  /** Gitea user of this Claude Code install, created by the plugin on first use. */
  claude?: Account;
  repos: Record<string, RepoEntry>;
}

/** Config directory: SLIPWAY_HOME, else ~/.slipway. */
export function slipwayHome(): string {
  return slipwayEnv('HOME') || join(homedir(), '.slipway');
}

export function configPath(): string {
  return join(slipwayHome(), 'config.json');
}

export function loadConfig(): SlipwayConfig {
  const p = configPath();
  if (!existsSync(p)) {
    throw new Error(`Slipway is not configured (${p} missing). Run "slipway init" first.`);
  }
  return JSON.parse(readFileSync(p, 'utf8')) as SlipwayConfig;
}

export function saveConfig(config: SlipwayConfig): void {
  mkdirSync(slipwayHome(), { recursive: true, mode: 0o700 });
  const p = configPath();
  writeFileSync(p, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  chmodSync(p, 0o600);
}
