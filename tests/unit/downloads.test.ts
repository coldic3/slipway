import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { download, giteaArtifact, gitleaksArtifact, platform } from '../../src/runtime/downloads.ts';

const fakeFetch = (body: string) => async () => new Response(body);

describe('pinned downloads', () => {
  it('maps macOS/Linux on x64/arm64 and refuses anything else', () => {
    expect(platform('darwin', 'arm64')).toBe('darwin-arm64');
    expect(platform('linux', 'x64')).toBe('linux-x64');
    expect(() => platform('win32', 'x64')).toThrow(/macOS and Linux/);
    expect(giteaArtifact('darwin-x64').url).toMatch(/gitea-28\.3\.0-darwin-amd64$/);
    expect(gitleaksArtifact('linux-arm64').url).toMatch(/gitleaks_8\.30\.1_linux_arm64\.tar\.gz$/);
  });

  it('every pinned artifact has a sha256', () => {
    for (const p of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'] as const) {
      expect(giteaArtifact(p).sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(gitleaksArtifact(p).sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('keeps a download whose checksum matches', async () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'sw-dl-')), 'bin');
    const sha256 = createHash('sha256').update('binary').digest('hex');
    await download({ url: 'https://x', sha256 }, dest, fakeFetch('binary'));
    expect(readFileSync(dest, 'utf8')).toBe('binary');
  });

  it('rejects and deletes a download whose checksum does not match', async () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'sw-dl-')), 'bin');
    await expect(download({ url: 'https://x', sha256: '0'.repeat(64) }, dest, fakeFetch('tampered'))).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('reports HTTP errors', async () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'sw-dl-')), 'bin');
    await expect(download({ url: 'https://x', sha256: '0'.repeat(64) }, dest, async () => new Response('no', { status: 404 }))).rejects.toThrow(/HTTP 404/);
  });
});
