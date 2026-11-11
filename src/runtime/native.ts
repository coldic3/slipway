import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { slipwayHome } from '../config.ts';
import { giteaUrlFor } from '../instance.ts';
import { run, runOk, type ExecResult } from '../util/exec.ts';
import { customDir } from './custom.ts';
import { giteaHealthy, waitForGitea } from './health.ts';
import { giteaSettings, mergeSettings, renderIni, type Sections } from './settings.ts';

/**
 * Gitea as a plain process on this machine (the default runtime, ADR 0002). Everything lives in ~/.slipway/gitea:
 * app.ini (regenerated on each start), secrets.json, data/, log/, custom/ (branding copy) and gitea.pid.
 */
export function nativePaths(home = slipwayHome()) {
  const dir = join(home, 'gitea');
  return {
    dir,
    ini: join(dir, 'app.ini'),
    secrets: join(dir, 'secrets.json'),
    pid: join(dir, 'gitea.pid'),
    data: join(dir, 'data'),
    log: join(dir, 'log'),
    custom: customDir(),
  };
}
export type NativePaths = ReturnType<typeof nativePaths>;

export const SECRET_NAMES = ['SECRET_KEY', 'INTERNAL_TOKEN', 'JWT_SECRET', 'LFS_JWT_SECRET'] as const;
export type Secrets = Record<(typeof SECRET_NAMES)[number], string>;

/** Global flags put before the subcommand: `gitea --config … --work-path … --custom-path … <cmd>`. */
export function giteaGlobalArgs(p: NativePaths): string[] {
  return ['--config', p.ini, '--work-path', p.dir, '--custom-path', p.custom];
}

/** Gitea must not pick up GITEA_* variables meant for something else (e.g. a Docker-style GITEA__x__y). */
function giteaEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GITEA')) env[k] = v;
  return env;
}

export function nativeSettings(port: number, p: NativePaths, secrets: Secrets, runUser: string): Sections {
  return mergeSettings(giteaSettings(port), {
    '': { RUN_USER: runUser, WORK_PATH: p.dir },
    server: {
      PROTOCOL: 'http',
      // Security invariant: loopback only.
      HTTP_ADDR: '127.0.0.1',
      HTTP_PORT: String(port),
      DOMAIN: '127.0.0.1',
      APP_DATA_PATH: p.data,
      START_SSH_SERVER: 'false',
      LFS_START_SERVER: 'false',
      LFS_JWT_SECRET: secrets.LFS_JWT_SECRET,
    },
    database: { PATH: join(p.data, 'gitea.db') },
    repository: { ROOT: join(p.data, 'repositories') },
    security: { SECRET_KEY: secrets.SECRET_KEY, INTERNAL_TOKEN: secrets.INTERNAL_TOKEN },
    oauth2: { JWT_SECRET: secrets.JWT_SECRET },
    log: { MODE: 'file', ROOT_PATH: p.log },
  });
}

/** Secrets generated once by `gitea generate secret` and kept across app.ini rewrites. */
export async function ensureSecrets(bin: string, p: NativePaths): Promise<Secrets> {
  if (existsSync(p.secrets)) return JSON.parse(readFileSync(p.secrets, 'utf8')) as Secrets;
  const out = {} as Secrets;
  for (const name of SECRET_NAMES) out[name] = (await runOk(bin, ['generate', 'secret', name], { env: giteaEnv() })).stdout.trim();
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  writeFileSync(p.secrets, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  return out;
}

/** Writes app.ini from Slipway's settings. Returns true when its content changed (Gitea reads it only at start). */
export async function writeAppIni(bin: string, port: number, p: NativePaths = nativePaths()): Promise<boolean> {
  const secrets = await ensureSecrets(bin, p);
  mkdirSync(p.data, { recursive: true });
  mkdirSync(p.log, { recursive: true });
  const ini = renderIni(nativeSettings(port, p, secrets, userInfo().username));
  if (existsSync(p.ini) && readFileSync(p.ini, 'utf8') === ini) return false;
  writeFileSync(p.ini, ini, { mode: 0o600 });
  return true;
}

export function readPid(p: NativePaths = nativePaths()): number | undefined {
  if (!existsSync(p.pid)) return undefined;
  const n = Number(readFileSync(p.pid, 'utf8').trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** True when `pid` is alive and is a Gitea process (a stale pid file may point at an unrelated process). */
export async function isGiteaProcess(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const r = await run('ps', ['-p', String(pid), '-o', 'command=']);
  return r.code === 0 && /gitea/.test(r.stdout);
}

export async function nativeRunning(port: number, p: NativePaths = nativePaths()): Promise<boolean> {
  const pid = readPid(p);
  return pid !== undefined && (await isGiteaProcess(pid)) && (await giteaHealthy(giteaUrlFor(port)));
}

/** Starts Gitea detached (it outlives this process) and waits until it answers. app.ini must already exist. */
export async function nativeStart(bin: string, port: number, p: NativePaths = nativePaths()): Promise<void> {
  const out = openSync(join(p.log, 'stdout.log'), 'a');
  let exited: string | undefined;
  try {
    const child = spawn(bin, [...giteaGlobalArgs(p), 'web'], { cwd: p.dir, detached: true, stdio: ['ignore', out, out], env: giteaEnv() });
    child.once('exit', (code) => {
      exited = `Gitea exited right after start (code ${code}). Its log: ${join(p.log, 'stdout.log')}\n${tail(join(p.log, 'stdout.log'))}`;
    });
    child.once('error', (e) => { exited = `cannot start Gitea (${bin}): ${e.message}`; });
    if (child.pid) writeFileSync(p.pid, `${child.pid}\n`);
    child.unref();
  } finally {
    closeSync(out);
  }
  await waitForGitea(giteaUrlFor(port), 60_000, () => exited);
}

function tail(file: string, lines = 15): string {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

export async function nativeStop(p: NativePaths = nativePaths()): Promise<boolean> {
  const pid = readPid(p);
  if (pid === undefined || !(await isGiteaProcess(pid))) {
    rmSync(p.pid, { force: true });
    return false;
  }
  process.kill(pid, 'SIGTERM');
  const until = Date.now() + 15_000;
  while (Date.now() < until && (await isGiteaProcess(pid))) await new Promise((r) => setTimeout(r, 200));
  if (await isGiteaProcess(pid)) process.kill(pid, 'SIGKILL');
  rmSync(p.pid, { force: true });
  return true;
}

/** Deletes the instance's data (repos, database, secrets, logs). The downloaded binaries stay. */
export function nativePurge(p: NativePaths = nativePaths()): void {
  rmSync(p.dir, { recursive: true, force: true });
}

/** `gitea admin …` against the native instance (works while it runs: SQLite). */
export function nativeAdmin(bin: string, args: string[], p: NativePaths = nativePaths()): Promise<ExecResult> {
  return run(bin, [...giteaGlobalArgs(p), ...args], { cwd: p.dir, env: giteaEnv() });
}
