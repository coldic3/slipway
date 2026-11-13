import { join } from 'node:path';
import { claudeCode } from '../agents/index.ts';
import type { Account, SlipwayConfig } from '../config.ts';
import { binDir, fetchGitleaks, GITLEAKS_VERSION, type Platform } from '../runtime/downloads.ts';
import { run, type ExecResult } from '../util/exec.ts';

/**
 * `slipway sbx setup <name>`: wires an existing Docker Sandboxes (sbx) sandbox to this machine's Slipway (ADR 0015).
 * Gitea stays on the host; the sandbox gets Node, gitleaks, a copy of the config pointing at host.docker.internal, a network
 * rule for that port, GitHub over HTTPS (the sbx proxy holds the GitHub login) and the plugin. Safe to re-run.
 */

export type Sbx = (args: string[], opts?: { input?: string; timeoutMs?: number }) => Promise<ExecResult>;

export const defaultSbx: Sbx = (args, opts = {}) => run('sbx', args, { input: opts.input, timeoutMs: opts.timeoutMs ?? 120_000 });

export interface SandboxDeps {
  sbx: Sbx;
  loadConfig: () => SlipwayConfig;
  /** The host's Gitea answers at `url`. */
  healthy: (url: string) => Promise<boolean>;
  /** This machine's Claude Gitea account, enrolled on the host if needed (the sandbox shares it). */
  claudeAccount: (config: SlipwayConfig) => Promise<Account>;
  /** Host path of the pinned gitleaks for `p`, downloaded on first use. */
  gitleaks: (p: Platform, log: (m: string) => void) => Promise<string>;
  log: (m: string) => void;
}

export const MIN_NODE = 22;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The URL the sandbox reaches the host's Gitea at: loopback becomes host.docker.internal (same port). */
export function sandboxGiteaUrl(giteaUrl: string): string {
  const u = new URL(giteaUrl);
  if (LOOPBACK.has(u.hostname)) u.hostname = 'host.docker.internal';
  return u.toString().replace(/\/$/, '');
}

/** The policy target sbx uses for a host port: host.docker.internal:<port> is authorized as localhost:<port>. */
export function hostPolicyTarget(giteaUrl: string): string | undefined {
  const u = new URL(giteaUrl);
  if (!LOOPBACK.has(u.hostname)) return undefined;
  return `localhost:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
}

/**
 * The sandbox's copy of the config. Keeps what the plugin needs (the Claude account, the admin token for mirroring the base
 * branch, the repos) and drops the reviewer's password and token: the sandbox never acts as the reviewer.
 */
export function sandboxConfig(host: SlipwayConfig, claude: Account, name: string): SlipwayConfig {
  return {
    ...host,
    giteaUrl: sandboxGiteaUrl(host.giteaUrl),
    webUrl: host.webUrl ?? host.giteaUrl,
    reviewer: { username: host.reviewer.username, password: '', token: '' },
    claude,
    sandbox: name,
  };
}

export interface Probe { home: string; owner: string; arch: string; node: number | null; gitleaks: boolean; sshAgent: boolean }

// One exec gathers everything we need to know about the sandbox.
const PROBE = [
  'echo "home=$HOME"',
  'echo "owner=$(id -u):$(id -g)"',
  'echo "arch=$(uname -m)"',
  'echo "node=$(node -v 2>/dev/null)"',
  `if command -v gitleaks >/dev/null 2>&1 || [ -x "$HOME/.slipway/bin/gitleaks-${GITLEAKS_VERSION}" ]; then echo gitleaks=1; else echo gitleaks=0; fi`,
  'if [ -n "$SSH_AUTH_SOCK" ]; then echo ssh=1; else echo ssh=0; fi',
].join('; ');

export function parseProbe(out: string): Probe {
  const v = Object.fromEntries(out.split('\n').map((l) => l.trim().split(/=(.*)/s).slice(0, 2)).filter((p) => p.length === 2)) as Record<string, string>;
  const node = /^v(\d+)\./.exec(v.node ?? '');
  return { home: v.home ?? '', owner: v.owner ?? '', arch: v.arch ?? '', node: node ? Number(node[1]) : null, gitleaks: v.gitleaks === '1', sshAgent: v.ssh === '1' };
}

export function linuxPlatform(arch: string): Platform {
  if (arch === 'aarch64' || arch === 'arm64') return 'linux-arm64';
  if (arch === 'x86_64' || arch === 'amd64') return 'linux-x64';
  throw new Error(`the sandbox runs on ${arch || 'an unknown CPU'}; Slipway supports x64 and arm64`);
}

const tail = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ');

// Debian's Docker Hardened Images ship versioned Node packages; plain Debian falls back to `nodejs`.
const INSTALL_NODE = 'apt-get update -qq >/dev/null && (apt-get install -y -qq nodejs-24 || apt-get install -y -qq nodejs-22 || apt-get install -y -qq nodejs) >/dev/null';

export async function prepareSandbox(name: string, d: SandboxDeps): Promise<void> {
  const { sbx, log } = d;
  const exec = (args: string[], opts?: { input?: string; timeoutMs?: number; root?: boolean }) =>
    sbx(['exec', ...(opts?.input !== undefined ? ['-i'] : []), ...(opts?.root ? ['-u', 'root'] : []), name, ...args], opts);
  const sh = (script: string, opts?: { input?: string; timeoutMs?: number; root?: boolean }) => exec(['sh', '-c', script], opts);

  if ((await sbx(['version'])).code === 127) {
    throw new Error('Docker Sandboxes (sbx) is not installed: https://docs.docker.com/ai/sandboxes/');
  }
  const host = d.loadConfig();
  if (host.sandbox) throw new Error('run slipway sbx setup on the host, not inside a sandbox');
  if (!(await d.healthy(host.giteaUrl))) throw new Error(`Slipway is not running at ${host.giteaUrl}. Start it first: slipway up`);

  const probe = await sh(PROBE, { timeoutMs: 180_000 }); // starts a stopped sandbox
  if (probe.code === 125) throw new Error(`no sandbox "${name}" (see: sbx ls). Create it first, e.g. sbx create --name ${name} claude <your-clone>`);
  if (probe.code !== 0) throw new Error(`could not run a command in sandbox "${name}": ${tail(probe)}`);
  const p = parseProbe(probe.stdout);
  const platform = linuxPlatform(p.arch);
  if (!p.home.startsWith('/') || !/^\d+:\d+$/.test(p.owner)) throw new Error(`could not find the home directory in sandbox "${name}"`);

  // Network: the sandbox reaches Gitea on the host through sbx's proxy.
  const url = sandboxGiteaUrl(host.giteaUrl);
  const target = hostPolicyTarget(host.giteaUrl);
  if (target && (await sbx(['policy', 'check', 'network', '--sandbox', name, target])).code !== 0) {
    log(`allowing sandbox ${name} to reach Slipway (${target})`);
    const allow = await sbx(['policy', 'allow', 'network', '--sandbox', name, target]);
    if (allow.code !== 0) throw new Error(`could not allow ${target} for the sandbox: ${tail(allow)}`);
  }
  const reach = await exec(['curl', '-fsS', '-o', '/dev/null', '--max-time', '10', `${url}/api/healthz`]);
  if (reach.code !== 0) throw new Error(`the sandbox cannot reach Slipway at ${url}: ${tail(reach)}`);

  // Node runs the plugin's MCP server and guard hook.
  if (p.node === null || p.node < MIN_NODE) {
    log(`installing Node.js in sandbox ${name}…`);
    const inst = await sh(INSTALL_NODE, { root: true, timeoutMs: 600_000 });
    const after = parseProbe((await sh('echo "node=$(node -v 2>/dev/null)"')).stdout).node;
    if (inst.code !== 0 || after === null || after < MIN_NODE) {
      throw new Error(`could not install Node.js ${MIN_NODE}+ in sandbox ${name} (${tail(inst) || `found ${after ?? 'none'}`}). Install it there and run this again.`);
    }
  }

  // gitleaks: promotion is blocked without it (ADR 0007). Downloaded and checked on the host, then copied in.
  const sbxBin = `${p.home}/.slipway/bin`;
  if (!p.gitleaks) {
    const local = await d.gitleaks(platform, log);
    const dest = `${sbxBin}/gitleaks-${GITLEAKS_VERSION}`;
    // sbx cp keeps the host's uid: hand the file to the sandbox user.
    const ok = (await exec(['mkdir', '-p', sbxBin])).code === 0
      && (await sbx(['cp', local, `${name}:${dest}`])).code === 0
      && (await exec(['chown', p.owner, dest], { root: true })).code === 0
      && (await exec(['chmod', '755', dest], { root: true })).code === 0;
    if (!ok) throw new Error(`could not copy gitleaks into sandbox ${name}`);
  }

  // GitHub: without an SSH agent, SSH remotes go over HTTPS, where the sbx proxy adds the GitHub login.
  if (!p.sshAgent) {
    for (const from of ['git@github.com:', 'ssh://git@github.com/']) {
      const pattern = `^${from.replace(/\./g, '\\.')}$`;
      const r = await exec(['git', 'config', '--global', '--replace-all', 'url.https://github.com/.insteadOf', from, pattern]);
      if (r.code !== 0) throw new Error(`could not configure git in sandbox ${name}: ${tail(r)}`);
    }
  }

  // The config copy. Written through stdin: it never touches the host's disk outside ~/.slipway.
  const claude = await d.claudeAccount(host);
  const json = JSON.stringify(sandboxConfig(host, claude, name), null, 2) + '\n';
  const write = await sh('umask 077 && mkdir -p "$HOME/.slipway" && cat > "$HOME/.slipway/config.json.tmp" && mv "$HOME/.slipway/config.json.tmp" "$HOME/.slipway/config.json"', { input: json });
  if (write.code !== 0) throw new Error(`could not write Slipway's config in sandbox ${name}: ${tail(write)}`);

  // The plugin, inside the sandbox's Claude Code.
  const plugin = await claudeCode.install(log, (cmd, args) => exec([cmd, ...args], { timeoutMs: 300_000 }));
  const notes: string[] = [];
  if (!plugin.done) notes.push(`Install the plugin in the sandbox's Claude Code: ${plugin.manual?.join(' then ')}`);

  // Registered repos among the sandbox's workspaces; a GitHub login for promotion.
  const workspaces = await sandboxWorkspaces(sbx, name);
  const registered = new Set(Object.values(host.repos).map((r) => r.path));
  for (const w of workspaces) if (!registered.has(w)) notes.push(`${w} is not a Slipway repo yet: slipway repo add ${w}, then slipway sbx setup ${name} again`);
  if (!(await hasGitHubSecret(sbx, name))) {
    notes.push(`To promote from the sandbox (experimental; promoting from the host always works), give it your GitHub login (the sbx proxy keeps the token): sbx secret set github --sandbox ${name} --command 'gh auth token'`);
  }

  log(`sandbox ${name} is ready: Slipway at ${url}, Claude user ${claude.username}`);
  for (const n of notes) log(n);
  log(`In the sandbox's Claude Code, run /reload-plugins. Run slipway sbx setup ${name} again after slipway repo add or a port change.`);
}

async function sandboxWorkspaces(sbx: Sbx, name: string): Promise<string[]> {
  const r = await sbx(['ls', '--json']);
  if (r.code !== 0) return [];
  try {
    const list = JSON.parse(r.stdout) as { name: string; workspaces?: string[] }[];
    return list.find((s) => s.name === name)?.workspaces ?? [];
  } catch {
    return [];
  }
}

/** A `github` service secret, global or for this sandbox (`sbx secret ls`: SCOPE TYPE NAME SECRET). */
export async function hasGitHubSecret(sbx: Sbx, name: string): Promise<boolean> {
  const r = await sbx(['secret', 'ls']);
  if (r.code !== 0) return false;
  return r.stdout.split('\n').some((line) => {
    const [scope, , service] = line.trim().split(/\s+/);
    return service === 'github' && (scope === '(global)' || scope === name);
  });
}

/** Where the host keeps the Linux gitleaks for sandboxes. */
export function sandboxGitleaksPath(p: Platform): string {
  return join(binDir(), p, `gitleaks-${GITLEAKS_VERSION}`);
}

export const defaultGitleaks = (p: Platform, log: (m: string) => void) => fetchGitleaks(p, sandboxGitleaksPath(p), log);
