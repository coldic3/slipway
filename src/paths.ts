import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of the Slipway installation (contains gitea/ and docker/): `src/..` in a checkout, `dist/..` in the package. */
export const SLIPWAY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
