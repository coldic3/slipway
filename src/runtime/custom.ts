import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { slipwayHome } from '../config.ts';
import { SLIPWAY_ROOT } from '../paths.ts';

/** Slipway's Gitea branding (templates + assets, ADR 0001) as shipped in the package. */
export const SHIPPED_CUSTOM = join(SLIPWAY_ROOT, 'gitea');

/** The instance's copy of the branding, used by both runtimes, so the instance does not depend on where Slipway is installed. */
export function customDir(): string {
  return join(slipwayHome(), 'gitea', 'custom');
}

/**
 * Makes the instance's branding copy match the shipped one. Returns true when it changed (Gitea reads templates only at start).
 * The directory itself is kept and only its contents are replaced: the Docker runtime bind-mounts it into a running container.
 */
export function syncCustom(dest = customDir(), source = SHIPPED_CUSTOM): boolean {
  if (!existsSync(source)) throw new Error(`Slipway's Gitea branding is missing at ${source}: the installation is incomplete`);
  if (existsSync(dest) && treeDigest(dest) === treeDigest(source)) return false;
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(dest)) rmSync(join(dest, name), { recursive: true, force: true });
  cpSync(source, dest, { recursive: true });
  return true;
}

/** Digest of a directory tree: relative paths and file contents. */
export function treeDigest(dir: string): string {
  const hash = createHash('sha256');
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        hash.update(`d ${path}\0`);
        walk(path);
      } else {
        hash.update(`f ${path}\0`).update(readFileSync(join(dir, path))).update('\0');
      }
    }
  };
  walk('');
  return hash.digest('hex');
}
