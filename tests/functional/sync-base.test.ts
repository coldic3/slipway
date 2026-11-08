import { describe, expect, it } from 'vitest';
import { syncBase } from '../../src/setup/sync.ts';
import { git } from '../../src/util/exec.ts';
import { HUMAN, humanCommitOnOrigin, identityEnv, makeFixture } from '../helpers/git-fixture.ts';

describe('syncBase', () => {
  it('mirrors GitHub main (origin) into the Slipway main, also after it moved', async () => {
    const f = await makeFixture();
    await humanCommitOnOrigin(f, 'README.md', '# merged on GitHub\n', 'Merge PR #58');
    expect(await git(f.review, ['rev-parse', 'main'])).not.toBe(await git(f.origin, ['rev-parse', 'main']));
    await syncBase({ repoDir: f.clone, base: 'main', giteaRepoUrl: f.review, authArgs: [], env: identityEnv(HUMAN) });
    expect(await git(f.review, ['rev-parse', 'main'])).toBe(await git(f.origin, ['rev-parse', 'main']));
  });

  it('fails with a readable error when GitHub cannot be reached', async () => {
    const f = await makeFixture();
    await git(f.clone, ['remote', 'set-url', 'origin', '/nonexistent/origin.git'], identityEnv(HUMAN));
    await expect(syncBase({ repoDir: f.clone, base: 'main', giteaRepoUrl: f.review, authArgs: [], env: identityEnv(HUMAN) })).rejects.toThrow(/fetch/i);
  });
});
