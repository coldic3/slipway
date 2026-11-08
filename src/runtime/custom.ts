import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { slipwayHome } from '../config.ts';
import { SLIPWAY_ROOT } from '../paths.ts';

/** Slipway's Gitea branding (templates + assets, ADR 0001) as shipped in the package. */
export const SHIPPED_CUSTOM = join(SLIPWAY_ROOT, 'gitea');

/** The instance's copy of the branding, used by both runtimes, so the instance does not depend on where Slipway is installed. */
export function customDir(): string {
  return join(slipwayHome(), 'gitea', 'custom');
}

export function syncCustom(dest = customDir(), source = SHIPPED_CUSTOM): void {
  if (!existsSync(source)) throw new Error(`Slipway's Gitea branding is missing at ${source}: the installation is incomplete`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(source, dest, { recursive: true });
}
