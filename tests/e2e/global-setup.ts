import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockGitHub } from '../helpers/mock-github.ts';
import { run, runOk } from '../../src/util/exec.ts';
import { E2E, E2E_DIR, e2eEnv, GITEA_URL, ROOT } from './helpers/env.ts';

const SLIPWAY = join(ROOT, 'bin', 'slipway');

export default async function globalSetup(): Promise<() => Promise<void>> {
  // Stop a previous run's Gitea first: its pid file (native) lives in the e2e home.
  await run(SLIPWAY, ['down', '--purge'], { env: e2eEnv() });
  rmSync(E2E_DIR, { recursive: true, force: true });
  mkdirSync(E2E.repos, { recursive: true });
  mkdirSync(E2E.fakeBin, { recursive: true });
  writeFileSync(join(E2E_DIR, 'gitconfig'), '[init]\n\tdefaultBranch = main\n');
  // A fake GitHub CLI: `gh auth token` prints the token the mock GitHub accepts.
  const gh = join(E2E.fakeBin, 'gh');
  writeFileSync(gh, `#!/bin/sh\nif [ "$1 $2" = "auth token" ]; then echo ${E2E.githubToken}; exit 0; fi\necho "fake gh: unsupported $*" >&2; exit 1\n`);
  chmodSync(gh, 0o755);

  const env = e2eEnv();
  // The one-shot setup a new user runs (no agent: the tests drive the bundled MCP server themselves).
  // No login flags: exercises the default slipway / slipway login.
  await runOk(SLIPWAY, ['init', '--yes', '--agent', 'none'], { env, timeoutMs: 400_000 });

  const github = new MockGitHub();
  const mockUrl = await github.start(0, '127.0.0.1');
  writeFileSync(E2E.stateFile, JSON.stringify({ mockUrl, giteaUrl: GITEA_URL }));

  return async () => {
    await github.stop();
  };
}
