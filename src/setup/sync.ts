import { loadConfig } from '../config.ts';
import { git, run } from '../util/exec.ts';
import { basicAuthArgs } from '../util/git-auth.ts';

export interface SyncBaseOptions {
  /** The local clone (remote "origin" = GitHub). */
  repoDir: string;
  base: string;
  /** Gitea clone URL of the review repo. */
  giteaRepoUrl: string;
  /** Per-command auth for Gitea (Slipway's admin: only it may push the protected base). */
  authArgs: string[];
  env?: NodeJS.ProcessEnv;
}

/** Mirrors GitHub's <base> (origin) into Slipway's <base> (force). Never uses a Gitea pull mirror. */
export async function syncBase(o: SyncBaseOptions): Promise<void> {
  const env = o.env ?? process.env;
  const fetch = await run('git', ['fetch', '--quiet', 'origin', `+refs/heads/${o.base}:refs/remotes/origin/${o.base}`], { cwd: o.repoDir, env, timeoutMs: 60_000 });
  if (fetch.code !== 0) throw new Error(`could not fetch ${o.base} from GitHub (origin): ${fetch.stderr.trim().split('\n').pop()}`);
  await git(o.repoDir, [...o.authArgs, '-c', 'credential.helper=', 'push', '--quiet', '--force', o.giteaRepoUrl, `refs/remotes/origin/${o.base}:refs/heads/${o.base}`], env);
}

export async function syncMain(name: string): Promise<void> {
  const config = loadConfig();
  const repo = config.repos[name];
  if (!repo) throw new Error(`Unknown repo "${name}". Known: ${Object.keys(config.repos).join(', ') || '(none)'}`);
  await syncBase({
    repoDir: repo.path,
    base: repo.base,
    giteaRepoUrl: `${config.giteaUrl.replace(/\/$/, '')}/${config.org}/${name}.git`,
    authArgs: basicAuthArgs(config.admin.username, config.admin.token),
  });
}
