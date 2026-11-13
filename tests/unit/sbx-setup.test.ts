import { describe, expect, it } from 'vitest';
import type { SlipwayConfig } from '../../src/config.ts';
import {
  hasGitHubSecret, hostPolicyTarget, linuxPlatform, parseProbe, prepareSandbox, sandboxConfig, sandboxGiteaUrl, type Sbx,
} from '../../src/sbx/setup.ts';
import type { ExecResult } from '../../src/util/exec.ts';

const host = (): SlipwayConfig => ({
  giteaUrl: 'http://127.0.0.1:3030', org: 'repos',
  admin: { username: 'admin', password: 'ap', token: 'at' },
  reviewer: { username: 'slipway', password: 'rp', token: 'rt' },
  claude: { username: 'claude-mac', password: 'cp', token: 'ct' },
  repos: { demo: { path: '/Users/k/demo', base: 'main', github: 'k/demo' } },
});

type Reply = Partial<ExecResult>;
function fakeSbx(replies: Record<string, Reply | ((input?: string) => Reply)>) {
  const calls: { line: string; input?: string }[] = [];
  const sbx: Sbx = async (args, opts) => {
    const line = args.join(' ');
    calls.push({ line, input: opts?.input });
    const key = Object.keys(replies).filter((k) => line.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    const r = key ? replies[key] : {};
    return { code: 0, stdout: '', stderr: '', ...(typeof r === 'function' ? r(opts?.input) : r) };
  };
  return { sbx, calls };
}

const PROBE_OK = 'home=/home/agent\nowner=1000:1000\narch=aarch64\nnode=v24.1.0\ngitleaks=1\nssh=0\n';
const deps = (sbx: Sbx, over: Partial<Parameters<typeof prepareSandbox>[1]> = {}) => ({
  sbx, loadConfig: host, healthy: async () => true, claudeAccount: async (c: SlipwayConfig) => c.claude!,
  gitleaks: async () => '/host/bin/linux-arm64/gitleaks', log: () => {}, ...over,
});

describe('slipway sbx setup', () => {
  it('points the sandbox at the host through host.docker.internal, same port', () => {
    expect(sandboxGiteaUrl('http://127.0.0.1:3030')).toBe('http://host.docker.internal:3030');
    expect(sandboxGiteaUrl('http://localhost:3514/')).toBe('http://host.docker.internal:3514');
    expect(sandboxGiteaUrl('https://gitea.example.com')).toBe('https://gitea.example.com');
    expect(hostPolicyTarget('http://127.0.0.1:3030')).toBe('localhost:3030');
    expect(hostPolicyTarget('https://gitea.example.com')).toBeUndefined();
  });

  it('the sandbox copy keeps the Claude account and drops the reviewer credentials', () => {
    const c = sandboxConfig(host(), host().claude!, 'claude-demo');
    expect(c.giteaUrl).toBe('http://host.docker.internal:3030');
    expect(c.webUrl).toBe('http://127.0.0.1:3030');
    expect(c.sandbox).toBe('claude-demo');
    expect(c.reviewer).toEqual({ username: 'slipway', password: '', token: '' });
    expect(c.claude?.token).toBe('ct');
    expect(c.repos).toEqual(host().repos);
  });

  it('parses the probe and the CPU', () => {
    expect(parseProbe(PROBE_OK)).toEqual({ home: '/home/agent', owner: '1000:1000', arch: 'aarch64', node: 24, gitleaks: true, sshAgent: false });
    expect(parseProbe('home=/h\narch=x86_64\nnode=\ngitleaks=0\nssh=1').node).toBeNull();
    expect(linuxPlatform('aarch64')).toBe('linux-arm64');
    expect(linuxPlatform('x86_64')).toBe('linux-x64');
    expect(() => linuxPlatform('riscv64')).toThrow(/x64 and arm64/);
  });

  it('finds a global or sandbox-scoped GitHub secret', async () => {
    const ls = (stdout: string) => fakeSbx({ 'secret ls': { stdout } }).sbx;
    const header = 'SCOPE      TYPE      NAME        SECRET\n';
    expect(await hasGitHubSecret(ls(header + '(global)   service   anthropic   (oauth configured)\n'), 'sb')).toBe(false);
    expect(await hasGitHubSecret(ls(header + '(global)   service   github   (command)\n'), 'sb')).toBe(true);
    expect(await hasGitHubSecret(ls(header + 'sb   service   github   (command)\n'), 'sb')).toBe(true);
    expect(await hasGitHubSecret(ls(header + 'other   service   github   (command)\n'), 'sb')).toBe(false);
  });

  it('a ready sandbox: checks the rule and reach, writes the config through stdin, (re)installs the plugin', async () => {
    const { sbx, calls } = fakeSbx({ 'exec sb sh -c echo "home=': { stdout: PROBE_OK }, 'secret ls': { stdout: '(global) service github x' } });
    const logs: string[] = [];
    await prepareSandbox('sb', deps(sbx, { log: (m) => logs.push(m) }));
    const lines = calls.map((c) => c.line);
    expect(lines).toContain('policy check network --sandbox sb localhost:3030');
    expect(lines.some((l) => l.startsWith('policy allow'))).toBe(false);
    expect(lines).toContain('exec sb curl -fsS -o /dev/null --max-time 10 http://host.docker.internal:3030/api/healthz');
    expect(lines.some((l) => l.includes('apt-get'))).toBe(false);
    expect(lines.some((l) => l.startsWith('cp '))).toBe(false);
    expect(lines).toContain('exec sb git config --global --replace-all url.https://github.com/.insteadOf git@github.com: ^git@github\\.com:$');
    const write = calls.find((c) => c.line.startsWith('exec -i sb sh -c umask 077'))!;
    const written = JSON.parse(write.input!) as SlipwayConfig;
    expect(written.sandbox).toBe('sb');
    expect(written.reviewer.token).toBe('');
    expect(lines).toContain('exec sb claude plugin install slipway@slipway');
    expect(logs.join('\n')).toMatch(/sandbox sb is ready/);
    expect(logs.join('\n')).not.toMatch(/secret set github/);
  });

  it('a fresh sandbox: allows the port, installs Node as root, copies gitleaks, keeps an SSH agent setup alone', async () => {
    let node = '';
    const { sbx, calls } = fakeSbx({
      'exec sb sh -c echo "home=': { stdout: 'home=/home/agent\nowner=1000:1000\narch=x86_64\nnode=\ngitleaks=0\nssh=1\n' },
      'exec sb sh -c echo "node=': () => ({ stdout: `node=${node}` }),
      'exec -u root sb sh -c apt-get': () => { node = 'v24.0.0'; return {}; },
      'policy check': { code: 1 },
      'ls --json': { stdout: JSON.stringify([{ name: 'sb', workspaces: ['/Users/k/demo', '/Users/k/other'] }]) },
    });
    const logs: string[] = [];
    let platform = '';
    await prepareSandbox('sb', deps(sbx, { log: (m) => logs.push(m), gitleaks: async (p) => { platform = p; return '/host/gl'; } }));
    const lines = calls.map((c) => c.line);
    expect(lines).toContain('policy allow network --sandbox sb localhost:3030');
    expect(platform).toBe('linux-x64');
    expect(lines).toContain('cp /host/gl sb:/home/agent/.slipway/bin/gitleaks-8.30.1');
    expect(lines).toContain('exec -u root sb chown 1000:1000 /home/agent/.slipway/bin/gitleaks-8.30.1');
    expect(lines.some((l) => l.includes('insteadOf'))).toBe(false);
    const out = logs.join('\n');
    expect(out).toMatch(/\/Users\/k\/other is not a Slipway repo yet/);
    expect(out).not.toMatch(/\/Users\/k\/demo is not/);
    expect(out).toMatch(/sbx secret set github --sandbox sb --command 'gh auth token'/);
  });

  it('stops with a clear message when Node cannot be installed', async () => {
    const { sbx } = fakeSbx({ 'exec sb sh -c echo "home=': { stdout: 'home=/h\nowner=1:1\narch=x86_64\nnode=v20.1.0\ngitleaks=1\nssh=0' }, 'exec sb sh -c echo "node=': { stdout: 'node=v20.1.0' } });
    await expect(prepareSandbox('sb', deps(sbx))).rejects.toThrow(/Node\.js 22\+/);
  });

  it('refuses early: no sbx, Slipway down, unknown sandbox, unreachable host, inside a sandbox', async () => {
    await expect(prepareSandbox('sb', deps(fakeSbx({ version: { code: 127 } }).sbx))).rejects.toThrow(/not installed/);
    await expect(prepareSandbox('sb', deps(fakeSbx({}).sbx, { healthy: async () => false }))).rejects.toThrow(/slipway up/);
    await expect(prepareSandbox('sb', deps(fakeSbx({ 'exec sb sh': { code: 125 } }).sbx))).rejects.toThrow(/no sandbox "sb"/);
    const unreachable = fakeSbx({ 'exec sb sh -c echo "home=': { stdout: PROBE_OK }, 'exec sb curl': { code: 7, stderr: 'Failed to connect' } });
    await expect(prepareSandbox('sb', deps(unreachable.sbx))).rejects.toThrow(/cannot reach Slipway at http:\/\/host\.docker\.internal:3030/);
    await expect(prepareSandbox('sb', deps(fakeSbx({}).sbx, { loadConfig: () => ({ ...host(), sandbox: 'x' }) }))).rejects.toThrow(/on the host/);
  });
});
