import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PORT, loadInstance, parsePort, parseRuntime, resolvePort, saveInstance } from '../../src/instance.ts';
import { resolveRuntime } from '../../src/runtime/index.ts';

describe('instance', () => {
  const prev = { home: process.env.SLIPWAY_HOME, port: process.env.SLIPWAY_PORT, runtime: process.env.SLIPWAY_RUNTIME };
  beforeEach(() => {
    process.env.SLIPWAY_HOME = mkdtempSync(join(tmpdir(), 'sw-home-'));
    delete process.env.SLIPWAY_PORT;
    delete process.env.SLIPWAY_RUNTIME;
  });
  afterEach(() => {
    for (const [k, v] of [['SLIPWAY_HOME', prev.home], ['SLIPWAY_PORT', prev.port], ['SLIPWAY_RUNTIME', prev.runtime]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults to port 3514', () => {
    expect(DEFAULT_PORT).toBe(3514);
    expect(resolvePort(undefined, undefined, {})).toBe(3514);
  });

  it('port order: --port, SLIPWAY_PORT, the instance, default', () => {
    const inst = { runtime: 'native' as const, port: 3030 };
    expect(resolvePort('4000', inst, { SLIPWAY_PORT: '4100' })).toBe(4000);
    expect(resolvePort(undefined, inst, { SLIPWAY_PORT: '4100' })).toBe(4100);
    expect(resolvePort(undefined, inst, {})).toBe(3030);
  });

  it('rejects ports that are not numbers in 1024–65535', () => {
    for (const bad of ['abc', '80', '70000', '3514.5']) expect(() => parsePort(bad)).toThrow(/invalid port/);
  });

  it('runtime order: flag, SLIPWAY_RUNTIME, the instance, native', () => {
    expect(resolveRuntime(undefined, undefined)).toBe('native');
    expect(resolveRuntime(undefined, { runtime: 'docker', port: 1 })).toBe('docker');
    process.env.SLIPWAY_RUNTIME = 'native';
    expect(resolveRuntime(undefined, { runtime: 'docker', port: 1 })).toBe('native');
    expect(resolveRuntime('docker', undefined)).toBe('docker');
    expect(() => parseRuntime('podman')).toThrow(/native or docker/);
  });

  it('round-trips instance.json', () => {
    expect(loadInstance()).toBeUndefined();
    saveInstance({ runtime: 'native', port: 3514, giteaBin: '/x/gitea-28.3.0' });
    expect(loadInstance()).toEqual({ runtime: 'native', port: 3514, giteaBin: '/x/gitea-28.3.0' });
  });
});
