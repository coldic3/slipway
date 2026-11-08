import { join, resolve } from 'node:path';

/** Shared e2e constants. Everything lives in an isolated SLIPWAY_HOME, port and (Docker runtime) compose project. */
export const ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const E2E_DIR = join(ROOT, '.e2e-tmp');
export const E2E = {
  project: 'slipway-e2e',
  giteaPort: process.env.SLIPWAY_E2E_PORT || '3300',
  /** native (default) or docker: SLIPWAY_E2E_RUNTIME. */
  runtime: process.env.SLIPWAY_E2E_RUNTIME || 'native',
  /** Downloaded Gitea/gitleaks binaries survive between runs (and are cached in CI). */
  binDir: join(ROOT, '.e2e-cache', 'bin'),
  home: join(E2E_DIR, 'home'),
  repos: join(E2E_DIR, 'repos'),
  stateFile: join(E2E_DIR, 'state.json'),
  fakeBin: join(E2E_DIR, 'bin'),
  claudeUser: 'claude-e2e',
  /** Your login (reviewer). */
  reviewer: 'slipway',
  password: 'slipway',
  /** Org that owns the review repos. */
  org: 'repos',
  admin: 'admin',
  githubToken: 'e2e-github-token',
  human: { name: 'Kevin E2E', email: 'kevin@e2e.local' },
};
export const GITEA_URL = `http://127.0.0.1:${E2E.giteaPort}`;

/** Environment for any slipway process in the e2e run. */
export function e2eEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SLIPWAY_HOME: E2E.home,
    SLIPWAY_PROJECT: E2E.project,
    SLIPWAY_PORT: E2E.giteaPort,
    SLIPWAY_RUNTIME: E2E.runtime,
    SLIPWAY_BIN_DIR: E2E.binDir,
    SLIPWAY_E2E_DIR: E2E_DIR,
    GIT_AUTHOR_NAME: E2E.human.name,
    GIT_AUTHOR_EMAIL: E2E.human.email,
    GIT_COMMITTER_NAME: E2E.human.name,
    GIT_COMMITTER_EMAIL: E2E.human.email,
    GIT_CONFIG_GLOBAL: join(E2E_DIR, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}
