import { slipwayEnv } from '../env.ts';
import { run, type ExecResult } from '../util/exec.ts';

export type Runner = (cmd: string, args: string[]) => Promise<ExecResult>;

/** GitHub token for promotion: SLIPWAY_GITHUB_TOKEN if set, else the `gh` CLI login. Never stored. */
export async function githubToken(runner: Runner = (c, a) => run(c, a, { timeoutMs: 15_000 })): Promise<string> {
  const env = slipwayEnv('GITHUB_TOKEN');
  if (env) return env;
  const r = await runner('gh', ['auth', 'token']);
  if (r.code === 127) throw new Error('The GitHub CLI (gh) is not installed. Install it and run: gh auth login');
  const token = r.stdout.trim();
  if (r.code !== 0 || !token) throw new Error('The GitHub CLI is not logged in. Run: gh auth login');
  return token;
}
