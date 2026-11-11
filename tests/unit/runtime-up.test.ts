import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  syncCustom: vi.fn(() => false),
  dockerUp: vi.fn(async () => {}),
  dockerRunning: vi.fn(async () => true),
  dockerDown: vi.fn(async () => {}),
  writeAppIni: vi.fn(async () => false),
  nativeRunning: vi.fn(async () => true),
  nativeStart: vi.fn(async () => {}),
  nativeStop: vi.fn(async () => true),
  ensureGitleaks: vi.fn(async () => {}),
}));

vi.mock('../../src/runtime/custom.ts', () => ({ syncCustom: m.syncCustom }));
vi.mock('../../src/runtime/docker.ts', () => ({
  dockerUp: m.dockerUp,
  dockerRunning: m.dockerRunning,
  dockerDown: m.dockerDown,
  dockerAdmin: vi.fn(),
}));
vi.mock('../../src/runtime/native.ts', () => ({
  writeAppIni: m.writeAppIni,
  nativeRunning: m.nativeRunning,
  nativeStart: m.nativeStart,
  nativeStop: m.nativeStop,
  nativeAdmin: vi.fn(),
  nativePurge: vi.fn(),
}));
vi.mock('../../src/runtime/downloads.ts', () => ({
  GITEA_VERSION: '28.3.0',
  ensureGitea: vi.fn(async () => '/bin/gitea-28.3.0'),
  ensureGitleaks: m.ensureGitleaks,
}));

const { saveInstance } = await import('../../src/instance.ts');
const { up } = await import('../../src/runtime/index.ts');

describe('slipway up on a running Gitea', () => {
  const prevHome = process.env.SLIPWAY_HOME;
  beforeEach(() => {
    process.env.SLIPWAY_HOME = mkdtempSync(join(tmpdir(), 'sw-home-'));
    for (const f of Object.values(m)) f.mockClear();
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.SLIPWAY_HOME;
    else process.env.SLIPWAY_HOME = prevHome;
  });

  it('Docker: re-applies the compose definition, so a container from an older Slipway is recreated', async () => {
    saveInstance({ runtime: 'docker', port: 3030 });
    await up();
    expect(m.syncCustom).toHaveBeenCalled();
    expect(m.dockerUp).toHaveBeenCalledWith(3030, { recreate: false });
    expect(m.dockerDown).not.toHaveBeenCalled();
  });

  it('Docker: forces a recreate when the branding changed (templates are read at start)', async () => {
    saveInstance({ runtime: 'docker', port: 3030 });
    m.syncCustom.mockReturnValueOnce(true);
    await up();
    expect(m.dockerUp).toHaveBeenCalledWith(3030, { recreate: true });
  });

  it('native: leaves Gitea alone when nothing changed', async () => {
    saveInstance({ runtime: 'native', port: 3514, giteaBin: '/bin/gitea-28.3.0' });
    await up();
    expect(m.syncCustom).toHaveBeenCalled();
    expect(m.writeAppIni).toHaveBeenCalledWith('/bin/gitea-28.3.0', 3514);
    expect(m.nativeStop).not.toHaveBeenCalled();
    expect(m.nativeStart).not.toHaveBeenCalled();
    expect(m.ensureGitleaks).toHaveBeenCalled();
  });

  it('native: restarts Gitea when the branding or app.ini changed', async () => {
    saveInstance({ runtime: 'native', port: 3514, giteaBin: '/bin/gitea-28.3.0' });
    m.syncCustom.mockReturnValueOnce(true);
    await up();
    m.writeAppIni.mockResolvedValueOnce(true);
    await up();
    expect(m.nativeStop).toHaveBeenCalledTimes(2);
    expect(m.nativeStart).toHaveBeenCalledTimes(2);
  });
});
