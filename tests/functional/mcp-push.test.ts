import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { pushBranch } from '../../src/mcp/push.ts';
import { git } from '../../src/util/exec.ts';
import { AGENT, identityEnv, makeFixture, type Fixture } from '../helpers/git-fixture.ts';

describe('pushBranch (slipway_push)', () => {
  let f: Fixture;
  const env = () => identityEnv(AGENT);
  const opts = () => ({ worktree: f.clone, repoDir: f.clone, url: f.review, authArgs: [] as string[], base: 'main', env: env() });
  beforeEach(async () => {
    f = await makeFixture();
    await git(f.clone, ['checkout', '-q', '-b', 'agent/1-x'], env());
    writeFileSync(join(f.clone, 'x.txt'), 'x\n');
    await git(f.clone, ['add', '.'], env());
    await git(f.clone, ['commit', '-qm', 'Add x'], env());
  });

  it('pushes the current branch', async () => {
    const r = await pushBranch({ ...opts(), branch: 'agent/1-x', force: false });
    expect(r.ok).toBe(true);
    expect(await git(f.review, ['rev-parse', 'refs/heads/agent/1-x'])).toBe(await git(f.clone, ['rev-parse', 'HEAD']));
  });

  it('refuses the base branch and detached HEAD', async () => {
    expect((await pushBranch({ ...opts(), branch: 'main', force: false })).ok).toBe(false);
    expect((await pushBranch({ ...opts(), branch: null, force: false })).ok).toBe(false);
  });

  it('force-with-lease works for any branch except the base (e.g. chore/om-skills), leasing on what this tool pushed last', async () => {
    await git(f.clone, ['checkout', '-q', '-b', 'chore/om-skills'], env());
    await pushBranch({ ...opts(), branch: 'chore/om-skills', force: false });
    await git(f.clone, ['commit', '-q', '--amend', '-m', 'Add x (folded fix)'], env());
    expect((await pushBranch({ ...opts(), branch: 'chore/om-skills', force: false })).ok).toBe(false); // non-fast-forward without force
    const forced = await pushBranch({ ...opts(), branch: 'chore/om-skills', force: true });
    expect(forced.ok, forced.message).toBe(true);
    expect(await git(f.review, ['log', '-1', '--format=%s', 'refs/heads/chore/om-skills'])).toBe('Add x (folded fix)');
    expect((await pushBranch({ ...opts(), branch: 'main', force: true })).ok).toBe(false);
  });

  it('force works for a branch first pushed to Slipway without this tool (no lease record), when Claude has seen its tip', async () => {
    await git(f.clone, ['push', '-q', f.review, 'HEAD:refs/heads/agent/1-x'], env()); // e.g. pushed before the plugin existed
    await git(f.clone, ['commit', '-q', '--amend', '-m', 'Add x (folded fix)'], env());
    const forced = await pushBranch({ ...opts(), branch: 'agent/1-x', force: true });
    expect(forced.ok, forced.message).toBe(true);
    expect(await git(f.review, ['log', '-1', '--format=%s', 'refs/heads/agent/1-x'])).toBe('Add x (folded fix)');
  });

  it('force is refused when someone else moved the branch on Gitea', async () => {
    await pushBranch({ ...opts(), branch: 'agent/1-x', force: false });
    // Someone else pushes to the same branch on Gitea.
    const other = join(f.root, 'other');
    await git(f.root, ['clone', '-q', '-b', 'agent/1-x', f.review, other], env());
    writeFileSync(join(other, 'y.txt'), 'y\n');
    await git(other, ['add', '.'], env());
    await git(other, ['commit', '-qm', 'Theirs'], env());
    await git(other, ['push', '-q', 'origin', 'agent/1-x'], env());
    await git(f.clone, ['commit', '-q', '--amend', '-m', 'Mine'], env());
    const r = await pushBranch({ ...opts(), branch: 'agent/1-x', force: true });
    expect(r.ok).toBe(false);
    expect(await git(f.review, ['log', '-1', '--format=%s', 'refs/heads/agent/1-x'])).toBe('Theirs');
  });
});
