// Bundles the slipway CLI into one self-contained ESM file (no runtime dependencies), the `bin` of the npm package.
// Usage: node scripts/build-cli.mjs [outfile]   (default: dist/slipway.mjs, git-ignored; built by `npm pack` via prepack)
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(process.argv[2] ?? join(root, 'dist', 'slipway.mjs'));

await build({
  absWorkingDir: root,
  entryPoints: ['src/cli.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning',
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __slipwayRequire } from 'node:module'; const require = __slipwayRequire(import.meta.url);" },
});
chmodSync(outfile, 0o755);
