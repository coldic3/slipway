import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { SLIPWAY_ROOT } from '../../src/paths.ts';
import { run } from '../../src/util/exec.ts';

const PLUGIN = join(SLIPWAY_ROOT, 'plugin');
const hasClaude = (await run('claude', ['--version'])).code === 0;

describe('Slipway plugin', () => {
  it('the bundled MCP server lists all Slipway tools and explains a non-registered repo', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dd-home-'));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ giteaUrl: 'http://127.0.0.1:9', admin: { username: 'admin', password: 'p', token: 't' }, reviewer: { username: 'slipway', password: 'p', token: 't' }, org: 'repos', repos: {} }));
    const cwd = mkdtempSync(join(tmpdir(), 'dd-cwd-'));
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StdioClientTransport({ command: 'node', args: [join(PLUGIN, 'dist', 'slipway-mcp.mjs')], cwd, env: { ...process.env, SLIPWAY_HOME: home } as Record<string, string> }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'slipway_open_pr', 'slipway_promote', 'slipway_push', 'slipway_reply', 'slipway_repo_conventions', 'slipway_review_comments', 'slipway_start_task', 'slipway_status', 'slipway_update_pr',
      ]);
      const r: any = await client.callTool({ name: 'slipway_status', arguments: { cwd } });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/slipway repo add/);
    } finally {
      await client.close();
    }
  });

  it('the bundled hook asks (JSON on stdout) or denies (exit 2) in a registered repo and ignores others', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dd-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'dd-repo-'));
    await run('git', ['init', '-q', repo]);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ giteaUrl: 'http://g', admin: { username: 'admin', password: 'p', token: 't' }, reviewer: { username: 'slipway', password: 'p', token: 't' }, org: 'repos', repos: { r: { path: repo, base: 'main', github: 'k/r' } } }));
    const hook = (cwd: string, command = 'git push origin main') => run('node', [join(PLUGIN, 'dist', 'slipway-hook.mjs')], {
      env: { ...process.env, SLIPWAY_HOME: home }, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
    });
    // Slipway (http://g) cannot be asked about "main": the user decides.
    const asked = await hook(repo);
    expect(asked.code).toBe(0);
    expect(JSON.parse(asked.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: expect.stringMatching(/slipway up/) } });
    const denied = await hook(repo, 'slipway promote r 1');
    expect(denied.code).toBe(2);
    expect(denied.stderr).toMatch(/slipway_promote/);
    const outside = await hook(tmpdir());
    expect(outside.code).toBe(0);
    expect(outside.stdout).toBe('');
  });

  it('the committed bundles are up to date with src/', async () => {
    const out = mkdtempSync(join(tmpdir(), 'dd-bundle-'));
    const r = await run('node', [join(SLIPWAY_ROOT, 'scripts', 'build-plugin.mjs'), out]);
    expect(r.code, r.stderr).toBe(0);
    for (const f of ['slipway-mcp.mjs', 'slipway-hook.mjs']) {
      expect(readFileSync(join(out, f), 'utf8') === readFileSync(join(PLUGIN, 'dist', f), 'utf8'), `${f} is stale: run npm run build:plugin`).toBe(true);
    }
  });

  it.skipIf(!hasClaude)('claude plugin validate accepts the plugin and the marketplace', async () => {
    const p = await run('claude', ['plugin', 'validate', PLUGIN]);
    expect(p.code, p.stdout + p.stderr).toBe(0);
    const m = await run('claude', ['plugin', 'validate', SLIPWAY_ROOT]);
    expect(m.code, m.stdout + m.stderr).toBe(0);
  });
});
