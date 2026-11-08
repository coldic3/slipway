import { existsSync } from 'node:fs';
import { gitleaksBinPath } from '../runtime/downloads.ts';
import { run, type ExecResult } from '../util/exec.ts';

export const GITLEAKS_IMAGE = 'zricethezav/gitleaks:v8.30.1';

export interface Finding { rule: string; file: string; line: number; commit: string }
export interface ScanResult { ok: boolean; findings: Finding[]; error?: string }
export type Runner = (cmd: string, args: string[]) => Promise<ExecResult>;

const defaultRunner: Runner = (cmd, args) => run(cmd, args, { timeoutMs: 5 * 60_000 });

/** gitleaks on PATH, else the copy `slipway up` downloaded (ADR 0002), else undefined (then the Docker image is tried). */
export async function localGitleaks(runner: Runner = defaultRunner, downloaded: string = gitleaksBinPath()): Promise<string | undefined> {
  if ((await runner('gitleaks', ['version'])).code !== 127) return 'gitleaks';
  return existsSync(downloaded) ? downloaded : undefined;
}

export async function gitleaksAvailable(runner: Runner = defaultRunner): Promise<boolean> {
  if (await localGitleaks(runner)) return true;
  return (await runner('docker', ['image', 'inspect', GITLEAKS_IMAGE])).code === 0 || (await runner('docker', ['version'])).code === 0;
}

/**
 * Scans the commits in `range` (e.g. "<baseSha>..<headSha>") of the repository at `repoDir` with gitleaks.
 * Fail closed: a missing scanner or any scanner error returns ok=false. Secrets are redacted.
 */
export async function scanSecrets(repoDir: string, range: string, runner: Runner = defaultRunner, downloaded?: string): Promise<ScanResult> {
  const common = ['git', '--no-banner', '--redact', '--exit-code', '1', '--report-format', 'json', '--report-path', '-', '--log-opts', range];
  const local = await localGitleaks(runner, downloaded);
  let r: ExecResult = local ? await runner(local, [...common, repoDir]) : { code: 127, stdout: '', stderr: '' };
  if (r.code === 127) {
    r = await runner('docker', [
      'run', '--rm', '-v', `${repoDir}:/repo:ro`,
      '-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory', '-e', 'GIT_CONFIG_VALUE_0=*',
      GITLEAKS_IMAGE, ...common, '/repo',
    ]);
    if (r.code === 127 || (r.code !== 0 && r.code !== 1 && /Cannot connect|not found|docker daemon/i.test(r.stderr))) {
      return { ok: false, findings: [], error: 'gitleaks is not available (run slipway up to download it, install gitleaks, or start Docker); promotion is blocked' };
    }
  }
  if (r.code !== 0 && r.code !== 1) return { ok: false, findings: [], error: `gitleaks failed (exit ${r.code}): ${r.stderr.slice(-500)}` };
  let raw: Array<{ RuleID: string; File: string; StartLine: number; Commit: string }> = [];
  try {
    raw = r.stdout.trim() ? JSON.parse(r.stdout) : [];
  } catch {
    return { ok: false, findings: [], error: `could not parse gitleaks output: ${r.stdout.slice(0, 200)}` };
  }
  const findings = raw.map((f) => ({ rule: f.RuleID, file: f.File, line: f.StartLine, commit: f.Commit }));
  if (r.code === 1 && findings.length === 0) return { ok: false, findings, error: 'gitleaks reported leaks but no findings were parsed' };
  return { ok: findings.length === 0, findings };
}
