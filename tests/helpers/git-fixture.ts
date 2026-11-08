import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../../src/util/exec.ts';

export const HUMAN = { name: 'Kevin Human', email: 'kevin@example.com' };
export const AGENT = { name: 'Slipway Agent', email: 'agent-bot@slipway.local' };

export function identityEnv(who: { name: string; email: string }): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email,
    GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
}

/** origin.git (GitHub stand-in), review.git (Gitea stand-in), clone (Kevin's local clone), agent (agent's clone). */
export interface Fixture { root: string; origin: string; review: string; clone: string; agent: string }

export async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'dd-fx-'));
  const f = { root, origin: join(root, 'origin.git'), review: join(root, 'review.git'), clone: join(root, 'clone'), agent: join(root, 'agent') };
  const h = identityEnv(HUMAN);
  await git(root, ['init', '-q', '--bare', '-b', 'main', f.origin], h);
  await git(root, ['init', '-q', '--bare', '-b', 'main', f.review], h);
  await git(root, ['clone', '-q', f.origin, f.clone], h);
  write(f.clone, 'README.md', '# demo\n');
  write(f.clone, 'src.txt', 'line1\nline2\nline3\n');
  await git(f.clone, ['add', '.'], h);
  await git(f.clone, ['commit', '-qm', 'Initial commit'], h);
  await git(f.clone, ['push', '-q', 'origin', 'main'], h);
  await git(f.clone, ['remote', 'add', 'review', f.review], h);
  await git(f.clone, ['push', '-q', 'review', 'origin/main:refs/heads/main'], h);
  await git(root, ['clone', '-q', f.review, f.agent], h);
  return f;
}

export function write(dir: string, file: string, content: string): void {
  writeFileSync(join(dir, file), content);
}

/** Agent commits on a branch in its clone and pushes it to review. */
export async function agentCommit(f: Fixture, branch: string, file: string, content: string, message: string): Promise<string> {
  const a = identityEnv(AGENT);
  const current = await git(f.agent, ['rev-parse', '--abbrev-ref', 'HEAD'], a);
  if (current !== branch) await git(f.agent, ['checkout', '-q', '-B', branch], a);
  write(f.agent, file, content);
  await git(f.agent, ['add', file], a);
  await git(f.agent, ['commit', '-qm', message], a);
  await git(f.agent, ['push', '-q', '-f', 'origin', `${branch}:${branch}`], a);
  return git(f.agent, ['rev-parse', 'HEAD'], a);
}

export async function humanCommitOnOrigin(f: Fixture, file: string, content: string, message: string): Promise<void> {
  const h = identityEnv(HUMAN);
  await git(f.clone, ['checkout', '-q', 'main'], h);
  await git(f.clone, ['pull', '-q', 'origin', 'main'], h);
  write(f.clone, file, content);
  await git(f.clone, ['add', file], h);
  await git(f.clone, ['commit', '-qm', message], h);
  await git(f.clone, ['push', '-q', 'origin', 'main'], h);
}

export function log(dir: string, range: string, fmt = '%s|%an|%cn'): Promise<string[]> {
  return git(dir, ['log', '--reverse', `--format=${fmt}`, range]).then((s) => (s ? s.split('\n') : []));
}
