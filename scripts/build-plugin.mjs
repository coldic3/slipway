// Bundles the Slipway MCP server and hook into self-contained ESM files for the Claude Code plugin.
// Installed plugins are copied without node_modules, so everything must be inside plugin/dist.
// Usage: node scripts/build-plugin.mjs [outdir]   (default: plugin/dist)
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(process.argv[2] ?? join(root, 'plugin', 'dist'));

const common = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning',
  banner: { js: "import { createRequire as __slipwayRequire } from 'node:module'; const require = __slipwayRequire(import.meta.url);" },
};

await build({ ...common, entryPoints: ['src/mcp/entry-server.ts'], outfile: join(outdir, 'slipway-mcp.mjs') });
await build({ ...common, entryPoints: ['src/mcp/entry-hook.ts'], outfile: join(outdir, 'slipway-hook.mjs') });
