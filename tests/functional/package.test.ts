import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SLIPWAY_ROOT } from '../../src/paths.ts';
import { run } from '../../src/util/exec.ts';
import { VERSION } from '../../src/version.ts';

describe('npm package', () => {
  it('ships only the CLI bundle, the Gitea branding, the compose file, README and LICENSE', async () => {
    const r = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: SLIPWAY_ROOT });
    expect(r.code, r.stderr).toBe(0);
    const files: string[] = JSON.parse(r.stdout)[0].files.map((f: { path: string }) => f.path);
    const allowed = /^(package\.json|README\.md|LICENSE|docker\/compose\.yaml|dist\/slipway\.mjs|gitea\/(public|templates)\/.+)$/;
    expect(files.filter((f) => !allowed.test(f))).toEqual([]);
    for (const f of ['package.json', 'README.md', 'LICENSE', 'docker/compose.yaml', 'gitea/templates/user/auth/signin.tmpl']) expect(files).toContain(f);
  });

  it('the bundled CLI runs on its own and knows its version', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'sw-cli-')), 'slipway.mjs');
    const b = await run('node', [join(SLIPWAY_ROOT, 'scripts', 'build-cli.mjs'), out]);
    expect(b.code, b.stderr).toBe(0);
    const v = await run(out, ['--version']);
    expect(v.stdout.trim()).toBe(VERSION);
    const h = await run(out, ['--help']);
    expect(h.stdout).toMatch(/slipway init/);
  });
});
