import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { slipwayHome } from '../config.ts';
import { slipwayEnv } from '../env.ts';
import { SLIPWAY_ROOT } from '../paths.ts';
import { run, runOk, type ExecResult } from '../util/exec.ts';
import { customDir } from './custom.ts';
import { giteaSettings, renderEnv } from './settings.ts';

/** The optional Docker runtime (ADR 0002): the official rootless image, same settings as native, data in compose volumes. */
export const COMPOSE_FILE = join(SLIPWAY_ROOT, 'docker', 'compose.yaml');
export const DEFAULT_PROJECT = 'slipway';

export function composeProject(): string {
  return slipwayEnv('PROJECT') || DEFAULT_PROJECT;
}

export function dockerEnvFile(): string {
  return join(slipwayHome(), 'docker', 'gitea.env');
}

function composeEnv(port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SLIPWAY_PROJECT: composeProject(),
    SLIPWAY_PORT: String(port),
    SLIPWAY_GITEA_ENV: dockerEnvFile(),
    SLIPWAY_GITEA_CUSTOM: customDir(),
  };
}

const composeArgs = (args: string[]) => ['compose', '-f', COMPOSE_FILE, ...args];

export function writeDockerEnv(port: number): void {
  mkdirSync(dirname(dockerEnvFile()), { recursive: true, mode: 0o700 });
  writeFileSync(dockerEnvFile(), renderEnv(giteaSettings(port)), { mode: 0o600 });
}

export async function dockerUp(port: number): Promise<void> {
  if ((await run('docker', ['version'])).code !== 0) {
    throw new Error('Docker is not running (or not installed). Start Docker, or use the default runtime without --docker.');
  }
  writeDockerEnv(port);
  await runOk('docker', composeArgs(['up', '-d', '--wait']), { env: composeEnv(port), timeoutMs: 300_000 });
}

export async function dockerDown(port: number, purge: boolean): Promise<void> {
  writeDockerEnv(port); // compose needs the file to exist even to tear down
  await runOk('docker', composeArgs(['down', ...(purge ? ['-v'] : [])]), { env: composeEnv(port) });
}

export async function dockerRunning(port: number): Promise<boolean> {
  const r = await run('docker', composeArgs(['ps', '--status', 'running', '-q', 'gitea']), { env: composeEnv(port) });
  return r.code === 0 && r.stdout.trim() !== '';
}

/** `gitea admin …` inside the container. */
export function dockerAdmin(port: number, args: string[]): Promise<ExecResult> {
  return run('docker', composeArgs(['exec', '-T', 'gitea', 'gitea', ...args]), { env: composeEnv(port) });
}
