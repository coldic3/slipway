import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { slipwayHome } from './config.ts';
import { slipwayEnv } from './env.ts';

export type RuntimeKind = 'native' | 'docker';
export const RUNTIMES: readonly RuntimeKind[] = ['native', 'docker'];

/** How this machine's Slipway Gitea runs (ADR 0002). Written by `slipway up`, read by later runs and by the plugin. */
export interface Instance {
  runtime: RuntimeKind;
  port: number;
  /** native: the Gitea binary the instance was started with (the plugin restarts it with the same one). */
  giteaBin?: string;
}

export const DEFAULT_PORT = 3514;

export function instancePath(): string {
  return join(slipwayHome(), 'instance.json');
}

export function loadInstance(): Instance | undefined {
  const p = instancePath();
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, 'utf8')) as Instance;
}

export function saveInstance(i: Instance): void {
  mkdirSync(slipwayHome(), { recursive: true, mode: 0o700 });
  writeFileSync(instancePath(), JSON.stringify(i, null, 2) + '\n', { mode: 0o600 });
}

export function parsePort(value: string | number): number {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`invalid port "${value}": use a number between 1024 and 65535`);
  return n;
}

/** Port order: --port, SLIPWAY_PORT, the instance's port, 3514. */
export function resolvePort(flag: string | number | undefined, instance: Instance | undefined, env: NodeJS.ProcessEnv = process.env): number {
  if (flag !== undefined && flag !== '') return parsePort(flag);
  const fromEnv = slipwayEnv('PORT', env);
  if (fromEnv) return parsePort(fromEnv);
  return instance?.port ?? DEFAULT_PORT;
}

export function parseRuntime(value: string): RuntimeKind {
  if ((RUNTIMES as readonly string[]).includes(value)) return value as RuntimeKind;
  throw new Error(`unknown runtime "${value}": use native or docker`);
}

export function giteaUrlFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}
