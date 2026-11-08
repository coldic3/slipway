import { spawn } from 'node:child_process';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class ExecError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly result: ExecResult,
  ) {
    super(`Command failed (exit ${result.code}): ${cmd}\n${result.stderr || result.stdout}`.trim());
  }
}

/** Runs a command without a shell. Never throws on non-zero exit; ENOENT gives code 127. */
export function run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        stderr += `\n[slipway] timed out after ${opts.timeoutMs} ms`;
        child.kill('SIGKILL');
      }, opts.timeoutMs);
    }
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      resolve({ code: err.code === 'ENOENT' ? 127 : 1, stdout, stderr: stderr + String(err.message) });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}

export async function runOk(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new ExecError(`${cmd} ${args.join(' ')}`, r);
  return r;
}

/** git helper: runOk('git', args) and return trimmed stdout. */
export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const r = await runOk('git', args, { cwd, env: env ?? process.env });
  return r.stdout.trim();
}
