import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { slipwayHome } from '../config.ts';
import { slipwayEnv } from '../env.ts';
import { run, runOk } from '../util/exec.ts';

/**
 * Pinned third-party binaries (ADR 0002). Versions and sha256 sums are part of Slipway's source: a download that does not
 * match is rejected. Bump them together with the Docker image in docker/compose.yaml and the CI gitleaks.
 */
export const GITEA_VERSION = '28.3.0';
export const GITLEAKS_VERSION = '8.30.1';

export type Platform = 'darwin-arm64' | 'darwin-x64' | 'linux-arm64' | 'linux-x64';

export interface Artifact { url: string; sha256: string }

const GITEA: Record<Platform, Artifact> = {
  'darwin-arm64': { url: giteaUrl('darwin-arm64'), sha256: '0aca8f1f1d6a0b31abc2c7e5c40feec18f3e45ab0c7b11deaef259794ce45812' },
  'darwin-x64': { url: giteaUrl('darwin-amd64'), sha256: '4420bb44df8047cd4f3bec9162d559c0245dee7ef3b58bc5540d7a1eefd8b94f' },
  'linux-arm64': { url: giteaUrl('linux-arm64'), sha256: '24d146e8f5c986b86e5a3311e3ec349ded35202cba056952ab5b585511ace82d' },
  'linux-x64': { url: giteaUrl('linux-amd64'), sha256: '5f834e8f04986f3b9206cf14743b5a6e6996ceddc238dac6409866ebda2a0686' },
};

const GITLEAKS: Record<Platform, Artifact> = {
  'darwin-arm64': { url: gitleaksUrl('darwin_arm64'), sha256: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5' },
  'darwin-x64': { url: gitleaksUrl('darwin_x64'), sha256: 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709' },
  'linux-arm64': { url: gitleaksUrl('linux_arm64'), sha256: 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080' },
  'linux-x64': { url: gitleaksUrl('linux_x64'), sha256: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' },
};

function giteaUrl(suffix: string): string {
  return `https://dl.gitea.com/gitea/${GITEA_VERSION}/gitea-${GITEA_VERSION}-${suffix}`;
}
function gitleaksUrl(suffix: string): string {
  return `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_${suffix}.tar.gz`;
}

export function platform(os: string = process.platform, arch: string = process.arch): Platform {
  const key = `${os}-${arch}`;
  if (key in GITEA) return key as Platform;
  throw new Error(`Slipway runs on macOS and Linux (x64, arm64); this machine is ${os}/${arch}`);
}

export function giteaArtifact(p: Platform = platform()): Artifact { return GITEA[p]; }
export function gitleaksArtifact(p: Platform = platform()): Artifact { return GITLEAKS[p]; }

/** Where downloaded binaries live: SLIPWAY_BIN_DIR, else ~/.slipway/bin. */
export function binDir(): string {
  return slipwayEnv('BIN_DIR') || join(slipwayHome(), 'bin');
}

export const giteaBinPath = () => join(binDir(), `gitea-${GITEA_VERSION}`);
export const gitleaksBinPath = () => join(binDir(), `gitleaks-${GITLEAKS_VERSION}`);

export type Fetch = (url: string) => Promise<Response>;

/** Downloads `a` to `dest` and checks its sha256; a mismatch deletes the file and throws. */
export async function download(a: Artifact, dest: string, fetchImpl: Fetch = fetch): Promise<void> {
  const res = await fetchImpl(a.url);
  if (!res.ok || !res.body) throw new Error(`download failed: ${a.url} (HTTP ${res.status})`);
  const part = `${dest}.part`;
  const hash = createHash('sha256');
  const tap = new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk); } });
  try {
    await pipeline(Readable.fromWeb(res.body as never), tap, createWriteStream(part, { mode: 0o755 }));
    const got = hash.digest('hex');
    if (got !== a.sha256) throw new Error(`checksum mismatch for ${a.url}: expected ${a.sha256}, got ${got}`);
    renameSync(part, dest);
  } finally {
    rmSync(part, { force: true });
  }
}

/** The pinned Gitea binary, downloaded on first use. */
export async function ensureGitea(log: (m: string) => void, fetchImpl: Fetch = fetch): Promise<string> {
  const dest = giteaBinPath();
  if (existsSync(dest)) return dest;
  mkdirSync(binDir(), { recursive: true });
  log(`downloading Gitea ${GITEA_VERSION} (about 110 MB, once)…`);
  await download(giteaArtifact(), dest, fetchImpl);
  chmodSync(dest, 0o755);
  return dest;
}

/** gitleaks: the one on PATH, else the pinned release in the bin dir (downloaded on first use). */
export async function ensureGitleaks(log: (m: string) => void, fetchImpl: Fetch = fetch): Promise<string> {
  if ((await run('gitleaks', ['version'])).code === 0) return 'gitleaks';
  const dest = gitleaksBinPath();
  if (existsSync(dest)) return dest;
  mkdirSync(binDir(), { recursive: true });
  log(`downloading gitleaks ${GITLEAKS_VERSION} (secret scanner, once)…`);
  const tmp = mkdtempSync(join(binDir(), '.gitleaks-'));
  try {
    const tgz = join(tmp, 'gitleaks.tar.gz');
    await download(gitleaksArtifact(), tgz, fetchImpl);
    await runOk('tar', ['-xzf', tgz, '-C', tmp, 'gitleaks']);
    chmodSync(join(tmp, 'gitleaks'), 0o755);
    renameSync(join(tmp, 'gitleaks'), dest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return dest;
}
