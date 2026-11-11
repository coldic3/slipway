import { existsSync, rmSync } from 'node:fs';
import { configPath, loadConfig, saveConfig } from '../config.ts';
import { slipwayEnv } from '../env.ts';
import { giteaUrlFor, instancePath, loadInstance, parseRuntime, resolvePort, saveInstance, type Instance, type RuntimeKind } from '../instance.ts';
import { setReviewRemote } from '../setup/repo.ts';
import type { ExecResult } from '../util/exec.ts';
import { syncCustom } from './custom.ts';
import { dockerAdmin, dockerDown, dockerRunning, dockerUp } from './docker.ts';
import { ensureGitea, ensureGitleaks, GITEA_VERSION } from './downloads.ts';
import { giteaHealthy } from './health.ts';
import { nativeAdmin, nativePurge, nativeRunning, nativeStart, nativeStop, writeAppIni } from './native.ts';
import { nextFreePort, portFree, PortBusyError } from './port.ts';

export interface UpOptions {
  port?: string | number;
  runtime?: RuntimeKind;
  log?: (m: string) => void;
}

/** Runtime order: --docker, SLIPWAY_RUNTIME, the instance's runtime, native. */
export function resolveRuntime(flag: RuntimeKind | undefined, instance: Instance | undefined): RuntimeKind {
  if (flag) return flag;
  const env = slipwayEnv('RUNTIME');
  if (env) return parseRuntime(env);
  return instance?.runtime ?? 'native';
}

export async function isRunning(i: Instance): Promise<boolean> {
  return i.runtime === 'native' ? nativeRunning(i.port) : dockerRunning(i.port);
}

/**
 * Starts (or restarts) Slipway's Gitea and records the instance (ADR 0002). Refuses a busy port with the exact command to use
 * instead, and a runtime switch (data does not move). A new port also updates config.json and the clones' `review` remotes.
 */
export async function up(opts: UpOptions = {}): Promise<Instance> {
  const log = opts.log ?? (() => {});
  const prev = loadInstance();
  const runtime = resolveRuntime(opts.runtime, prev);
  if (prev && prev.runtime !== runtime) {
    throw new Error(
      `Slipway already runs with the ${prev.runtime} runtime here; switching to ${runtime} would start with empty data.\n` +
        `To start over on ${runtime}: slipway down --purge, then slipway up${runtime === 'docker' ? ' --docker' : ''}.`,
    );
  }
  const port = resolvePort(opts.port, prev);

  if (prev && (await isRunning(prev))) {
    if (prev.port === port && (runtime === 'docker' || prev.giteaBin?.endsWith(`gitea-${GITEA_VERSION}`))) {
      await refreshRunning(prev, log);
      return prev;
    }
    log('restarting Gitea (new port or Gitea version)');
    await stop(prev);
  }
  if (!(await portFree(port))) throw new PortBusyError(port, await nextFreePort(port + 1));

  syncCustom();
  let instance: Instance;
  if (runtime === 'native') {
    const bin = await ensureGitea(log);
    await writeAppIni(bin, port);
    log(`starting Gitea ${GITEA_VERSION} on ${giteaUrlFor(port)}`);
    await nativeStart(bin, port);
    instance = { runtime, port, giteaBin: bin };
    await ensureGitleaks(log);
  } else {
    log(`starting Gitea in Docker on ${giteaUrlFor(port)}`);
    await dockerUp(port);
    instance = { runtime, port };
  }
  saveInstance(instance);
  await retargetConfig(port, log);
  return instance;
}

/**
 * `up` on a running Gitea of the right port and version: brings it in line with this Slipway (branding, settings and, for
 * Docker, the compose definition) and restarts it only when something it reads at start changed. Without this, an updated
 * Slipway kept serving the old instance, e.g. a container still mounting a branding path that no longer exists.
 */
async function refreshRunning(i: Instance, log: (m: string) => void): Promise<void> {
  const brandingChanged = syncCustom();
  if (i.runtime === 'docker') {
    if (brandingChanged) log("restarting Gitea (Slipway's branding changed)");
    await dockerUp(i.port, { recreate: brandingChanged });
  } else {
    if (!i.giteaBin) throw new Error('the instance has no Gitea binary recorded. Run: slipway down, then slipway up');
    const iniChanged = await writeAppIni(i.giteaBin, i.port);
    if (brandingChanged || iniChanged) {
      log(`restarting Gitea (Slipway's ${brandingChanged ? 'branding' : 'settings'} changed)`);
      await nativeStop();
      await nativeStart(i.giteaBin, i.port);
    }
    await ensureGitleaks(log);
  }
  log(`running at ${giteaUrlFor(i.port)}`);
}

async function stop(i: Instance): Promise<void> {
  if (i.runtime === 'native') await nativeStop();
  else await dockerDown(i.port, false);
}

/** Stops Gitea. --purge also deletes all of its data (and forgets the instance, so the next `up` may pick another runtime). */
export async function down(opts: { purge?: boolean } = {}): Promise<void> {
  const i = loadInstance();
  if (!i) return;
  if (i.runtime === 'native') {
    await nativeStop();
    if (opts.purge) nativePurge();
  } else {
    await dockerDown(i.port, !!opts.purge);
  }
  if (opts.purge) rmSync(instancePath(), { force: true });
}

/**
 * For the plugin: makes sure the recorded native Gitea answers, starting it with the binary and app.ini it was set up with
 * (after a reboot nothing runs; there is no OS service). Docker restarts by itself. No-op without an instance.
 */
export async function ensureRunning(): Promise<void> {
  const i = loadInstance();
  if (!i || (await giteaHealthy(giteaUrlFor(i.port)))) return;
  if (i.runtime !== 'native') {
    throw new Error(`Slipway's Gitea (Docker) is not running at ${giteaUrlFor(i.port)}. Ask the user to start Docker and run: slipway up`);
  }
  if (!i.giteaBin || !existsSync(i.giteaBin)) throw new Error('Slipway is not running. Ask the user to run: slipway up');
  if (!(await portFree(i.port))) throw new PortBusyError(i.port, await nextFreePort(i.port + 1));
  await nativeStart(i.giteaBin, i.port);
}

/** `gitea admin …` for the recorded instance. */
export function giteaAdmin(args: string[]): Promise<ExecResult> {
  const i = loadInstance();
  if (!i) throw new Error('Slipway is not running here yet. Run: slipway up');
  if (i.runtime === 'docker') return dockerAdmin(i.port, args);
  if (!i.giteaBin) throw new Error('the instance has no Gitea binary recorded. Run: slipway up');
  return nativeAdmin(i.giteaBin, args);
}

/** URL of this machine's Gitea: SLIPWAY_GITEA_URL, else 127.0.0.1 on the resolved port. */
export function defaultGiteaUrl(): string {
  return slipwayEnv('GITEA_URL') || giteaUrlFor(resolvePort(undefined, loadInstance()));
}

/** After a port change: config.json's giteaUrl and every registered clone's `review` remote follow. */
async function retargetConfig(port: number, log: (m: string) => void): Promise<void> {
  if (!existsSync(configPath()) || slipwayEnv('GITEA_URL')) return;
  const config = loadConfig();
  const url = giteaUrlFor(port);
  if (config.giteaUrl.replace(/\/$/, '') === url) return;
  config.giteaUrl = url;
  saveConfig(config);
  for (const [name, entry] of Object.entries(config.repos)) {
    if (existsSync(entry.path)) await setReviewRemote(config, name, entry.path).catch(() => {});
  }
  log(`Slipway moved to ${url} (config and review remotes updated)`);
}

export interface StatusReport { instance?: Instance; running: boolean; url?: string }

export async function status(): Promise<StatusReport> {
  const instance = loadInstance();
  if (!instance) return { running: false };
  return { instance, running: await isRunning(instance), url: giteaUrlFor(instance.port) };
}
