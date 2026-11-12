import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { originHasBranch, prepareBranch, pushToOrigin } from '../../src/promote/git.ts';
import { git } from '../../src/util/exec.ts';
import { AGENT, agentCommit, HUMAN, humanCommitOnOrigin, identityEnv, log, makeFixture, type Fixture } from '../helpers/git-fixture.ts';

const BR = 'agent/7-feature';

describe('promotion git engine (functional, real git) — exact promotion, no rewriting', () => {
  let f: Fixture;
  const env = () => identityEnv(HUMAN);
  const base = () => ({ repoDir: f.clone, reviewUrl: f.review, reviewAuthArgs: [], branch: BR, base: 'main', env: env() });

  beforeEach(async () => {
    f = await makeFixture();
    await agentCommit(f, BR, 'feature.txt', 'v1\n', 'Add feature');
    await agentCommit(f, BR, 'other.txt', 'o\n', 'Add other');
  });

  it('originHasBranch: true for a GitHub branch, false for a missing one (stacked PR parents)', async () => {
    expect(await originHasBranch(f.clone, 'main', [], env())).toBe(true);
    expect(await originHasBranch(f.clone, 'agent/3-parent', [], env())).toBe(false);
    await git(f.clone, ['remote', 'set-url', 'origin', join(f.root, 'nowhere')], env());
    await expect(originHasBranch(f.clone, 'main', [], env())).rejects.toThrow(/could not read branches/);
  });

  it('promotes the reviewed commits exactly as they are (same SHAs, nothing folded or re-authored)', async () => {
    await agentCommit(f, BR, 'feature.txt', 'v2\n', 'fixup! Add feature'); // even a leftover fixup is NOT folded
    const r = await prepareBranch(base());
    if (!r.ok) throw new Error('expected ok');
    const reviewed = await git(f.review, ['rev-parse', `refs/heads/${BR}`]);
    expect(r.fetchedHead).toBe(reviewed);
    expect(r.head).toBe(reviewed);
    expect(await log(r.worktree, 'origin/main..HEAD', '%s|%an')).toEqual(['Add feature|Slipway Agent', 'Add other|Slipway Agent', 'fixup! Add feature|Slipway Agent']);
    await r.cleanup();
    expect(existsSync(r.worktree)).toBe(false);
  });

  it('a branch that is behind origin/<base> is not promoted: ok:false with how far behind, no worktree left', async () => {
    await humanCommitOnOrigin(f, 'README.md', '# demo v2\n', 'Update readme');
    await humanCommitOnOrigin(f, 'README.md', '# demo v3\n', 'Update readme again');
    const r = await prepareBranch(base());
    expect(r).toEqual({ ok: false, behindBy: 2 });
    expect(await git(f.clone, ['worktree', 'list'])).not.toContain('slipway-promote');
  });

  it('a branch rebased onto the current origin/<base> is promoted as-is', async () => {
    await humanCommitOnOrigin(f, 'README.md', '# demo v2\n', 'Update readme');
    // The agent rebases in Slipway and force-pushes (what the fix-review/promote skills do).
    const a = identityEnv(AGENT);
    await git(f.agent, ['fetch', '-q', f.origin, 'main:refs/remotes/github/main'], a);
    await git(f.agent, ['rebase', '-q', 'github/main'], a);
    await git(f.agent, ['push', '-q', '-f', 'origin', `${BR}:${BR}`], a);
    const r = await prepareBranch(base());
    if (!r.ok) throw new Error('expected ok');
    expect(await git(r.worktree, ['show', 'HEAD:README.md'])).toBe('# demo v2');
    expect(r.head).toBe(await git(f.review, ['rev-parse', `refs/heads/${BR}`]));
    await r.cleanup();
  });

  it('never runs repository hooks during promotion (the agent shares .git)', async () => {
    const marker = join(f.root, 'hook-ran');
    mkdirSync(join(f.clone, '.git', 'hooks'), { recursive: true });
    for (const h of ['pre-push', 'post-checkout', 'pre-commit', 'post-rewrite']) {
      const file = join(f.clone, '.git', 'hooks', h);
      writeFileSync(file, `#!/bin/sh\necho ${h} >> ${marker}\n`);
      chmodSync(file, 0o755);
    }
    const r = await prepareBranch(base());
    if (!r.ok) throw new Error('expected ok');
    await pushToOrigin({ repoDir: f.clone, worktree: r.worktree, branch: BR, authArgs: [], reviewedHead: r.fetchedHead, env: env() });
    await r.cleanup();
    expect(existsSync(marker)).toBe(false);
  });

  it('re-promotion after the agent rewrote the branch in Slipway updates GitHub (lease on what Slipway pushed)', async () => {
    let r = await prepareBranch(base());
    if (!r.ok) throw new Error('expected ok');
    await pushToOrigin({ repoDir: f.clone, worktree: r.worktree, branch: BR, authArgs: [], reviewedHead: r.fetchedHead, env: env() });
    await r.cleanup();
    const a = identityEnv(AGENT);
    await git(f.agent, ['commit', '-q', '--amend', '-m', 'Add other (reworded)'], a);
    await git(f.agent, ['push', '-q', '-f', 'origin', `${BR}:${BR}`], a);
    r = await prepareBranch(base());
    if (!r.ok) throw new Error('expected ok');
    await pushToOrigin({ repoDir: f.clone, worktree: r.worktree, branch: BR, authArgs: [], reviewedHead: r.fetchedHead, env: env() });
    expect(await git(f.origin, ['log', '-1', '--format=%s', `refs/heads/${BR}`])).toBe('Add other (reworded)');
    await r.cleanup();
  });

  it('re-promotion refuses to overwrite commits someone else pushed to the GitHub branch', async () => {
    let r = await prepareBranch(base());
    if (!r.ok) throw new Error('expected ok');
    await pushToOrigin({ repoDir: f.clone, worktree: r.worktree, branch: BR, authArgs: [], reviewedHead: r.fetchedHead, env: env() });
    await r.cleanup();
    const other = join(f.root, 'gh-reviewer');
    await git(f.root, ['clone', '-q', '-b', BR, f.origin, other], env());
    writeFileSync(join(other, 'suggest.txt'), 's\n');
    await git(other, ['add', '.'], env());
    await git(other, ['commit', '-qm', 'Suggested change'], env());
    await git(other, ['push', '-q', 'origin', BR], env());
    const theirs = await git(other, ['rev-parse', 'HEAD']);
    await agentCommit(f, BR, 'more.txt', 'm\n', 'More');
    r = await prepareBranch(base());
    if (!r.ok) throw new Error('expected ok');
    await expect(pushToOrigin({ repoDir: f.clone, worktree: r.worktree, branch: BR, authArgs: [], reviewedHead: r.fetchedHead, env: env() })).rejects.toThrow(/not in the Slipway PR/);
    expect(await git(f.origin, ['rev-parse', `refs/heads/${BR}`])).toBe(theirs);
    await r.cleanup();
  });

  it('updates a branch that already exists on GitHub (PR opened before Slipway) when all its commits are in the reviewed branch', async () => {
    const firstAgentCommit = (await git(f.review, ['rev-list', '--reverse', `main..refs/heads/${BR}`])).split('\n')[0]!;
    await git(f.agent, ['push', '-q', f.origin, `${firstAgentCommit}:refs/heads/${BR}`], env());
    const r = await prepareBranch(base());
    if (!r.ok) throw new Error('expected ok');
    await pushToOrigin({ repoDir: f.clone, worktree: r.worktree, branch: BR, authArgs: [], reviewedHead: r.fetchedHead, env: env() });
    expect(await git(f.origin, ['rev-parse', `refs/heads/${BR}`])).toBe(r.head);
    await r.cleanup();
  });
});
