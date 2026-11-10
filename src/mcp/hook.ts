import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { loadConfig, type SlipwayConfig } from '../config.ts';
import { GiteaClient } from '../gitea/client.ts';
import { run } from '../util/exec.ts';
import { resolveRepo } from './context.ts';

/**
 * PreToolUse guard for Bash in Slipway repos: stops habits that would skip the local review
 * (pushing to GitHub, opening/merging PRs on GitHub, reading Slipway credentials). A guardrail against
 * mistakes, not a security boundary (ADR 0003).
 *
 * GitHub writes are judged per branch by its Slipway PR (ADR 0009):
 * - open PR → blocked, the work goes through Slipway first;
 * - no PR at all → blocked, the work has not been reviewed;
 * - only closed PRs (promoted, or deliberately closed) → allowed, the branch now lives on GitHub.
 */
export interface HookInput {
  tool_name: string;
  tool_input: { command?: string };
  cwd: string;
}

export type Decision = { block: false } | { block: true; reason: string };

/** State of a branch in Slipway: `open` if any PR for it is open, `closed` if it has only closed PRs. */
export type BranchState = 'open' | 'closed' | 'none';

export interface HookEnv {
  isRegistered(cwd: string): boolean;
  /** Current branch of the session's worktree, null on detached HEAD. */
  currentBranch(): string | null;
  /** Slipway PR state for a branch; throws when Slipway cannot be asked. */
  branchState(branch: string): Promise<BranchState>;
  /** Head branch of a GitHub PR given by number, URL or branch (as `gh pr <cmd> <arg>` takes it); null if unknown. */
  githubPrHead(ref: string): Promise<string | null>;
}

const GH_PR_WRITES = new Set(['create', 'edit', 'merge', 'close', 'reopen', 'ready', 'review', 'comment']);
const WRITE_METHODS = /^(POST|PATCH|PUT|DELETE)$/i;
/** `git push` options that take a separate value. */
const PUSH_OPTS_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
/** `gh pr` options that take a separate value (the positional PR selector must not be confused with them). */
const GH_PR_OPTS_WITH_VALUE = new Set(['-R', '--repo', '-t', '--title', '-b', '--body', '-F', '--body-file', '-B', '--base', '-H', '--head',
  '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-p', '--project', '-r', '--reviewer', '--add-label', '--remove-label',
  '--add-assignee', '--remove-assignee', '--add-reviewer', '--remove-reviewer', '--add-project', '--remove-project', '-c', '--comment',
  '--template', '--recover', '--subject', '--author-email', '--match-head-commit', '--delete-branch-on-merge']);

function words(segment: string): string[] {
  const w = segment.trim().split(/\s+/).filter(Boolean);
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) w.shift(); // leading VAR=value
  return w;
}

function gitSubcommandIndex(w: string[]): number {
  for (let i = 1; i < w.length; i++) {
    const a = w[i]!;
    if (a === '-c' || a === '-C' || a === '--git-dir' || a === '--work-tree') { i++; continue; }
    if (a.startsWith('-')) continue;
    return i;
  }
  return -1;
}

/** `gh api` options that take a separate value (so the endpoint is not confused with it). */
const GH_API_OPTS_WITH_VALUE = new Set(['-X', '--method', '-H', '--header', '-f', '-F', '--field', '--raw-field', '--input',
  '-q', '--jq', '-t', '--template', '--hostname', '-p', '--preview', '--cache']);

function ghApiEndpoint(w: string[]): string | null {
  for (let i = 2; i < w.length; i++) {
    const a = w[i]!;
    if (GH_API_OPTS_WITH_VALUE.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    return unquote(a);
  }
  return null;
}

const MUTATION = /\bmutation\b/;

/**
 * GraphQL always goes out as POST, so a write is told apart by the document: it writes if it contains a mutation.
 * The query may sit in the command itself (`-f query=…`, a heredoc on `--input -`) or in a file
 * (`--input q.json`, `-F query=@q.graphql`); an unreadable file counts as a write (fail closed).
 */
function graphqlWrites(w: string[], command: string, cwd: string): boolean {
  if (MUTATION.test(command)) return true;
  const files: string[] = [];
  for (let i = 2; i < w.length; i++) {
    const a = w[i]!;
    if (a === '--input') files.push(unquote(w[i + 1] ?? ''));
    else if (a.startsWith('--input=')) files.push(unquote(a.slice('--input='.length)));
    const field = a === '-F' || a === '--field' ? unquote(w[i + 1] ?? '') : a.startsWith('--field=') ? unquote(a.slice('--field='.length)) : '';
    const at = field.indexOf('=@');
    if (at > 0) files.push(field.slice(at + 2));
  }
  for (const f of files) {
    if (f === '-' || f === '') continue; // stdin: its text, if any, is in the command (heredoc), checked above
    try {
      if (MUTATION.test(readFileSync(resolve(cwd, f.replace(/^~(?=\/)/, homedir())), 'utf8'))) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function ghApiWrites(w: string[], command: string, cwd: string): boolean {
  if (ghApiEndpoint(w) === 'graphql') return graphqlWrites(w, command, cwd);
  for (let i = 2; i < w.length; i++) {
    const a = w[i]!;
    if ((a === '-X' || a === '--method') && WRITE_METHODS.test(w[i + 1] ?? '')) return true;
    if (/^(-X|--method=)(POST|PATCH|PUT|DELETE)$/i.test(a)) return true;
    if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a) || /^--(raw-)?field=/.test(a)) return true;
  }
  return false;
}

const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, '$2');

/**
 * Branches a `git push` publishes: `null` means "the current branch", a list names them explicitly,
 * `'all'` means it cannot be narrowed to PR branches (`--all`, `--mirror`, `--tags`, globs…).
 */
export function pushedBranches(args: string[]): Array<string | null> | 'all' {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--all' || a === '--mirror' || a === '--branches' || a === '--tags') return 'all';
    if (PUSH_OPTS_WITH_VALUE.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    positional.push(unquote(a));
  }
  const refspecs = positional.slice(1); // first positional is the remote
  if (refspecs.length === 0) return [null];
  const out: Array<string | null> = [];
  for (const spec of refspecs) {
    const s = spec.replace(/^\+/, '');
    const dst = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
    if (dst.includes('*')) return 'all';
    if (s.startsWith('refs/tags/') || dst.startsWith('refs/tags/')) return 'all'; // tags are not PR branches: not cleared by a PR
    const name = dst.replace(/^refs\/heads\//, '');
    out.push(name === '' || name === 'HEAD' || name === '@' ? null : name);
  }
  return out;
}

/** The PR selector of `gh pr <cmd> …` (number, URL or branch), or null for the current branch. */
export function ghPrSelector(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (GH_PR_OPTS_WITH_VALUE.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    return unquote(a);
  }
  return null;
}

/** For `gh pr create`: the `--head` branch, or null for the current branch. */
function ghCreateHead(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-H' || a === '--head') return unquote(args[i + 1] ?? '') || null;
    if (a.startsWith('--head=')) return unquote(a.slice('--head='.length)) || null;
  }
  return null;
}

const PUSH_HINT = 'push with the slipway_push tool (it pushes to the local review Gitea); GitHub gets the branch through promotion';

async function judgeBranch(branch: string | null, what: string, env: HookEnv): Promise<Decision> {
  if (!branch) {
    return { block: true, reason: `Slipway: cannot tell which branch ${what} targets (detached HEAD?). In this repo, ${PUSH_HINT}.` };
  }
  let state: BranchState;
  try {
    state = await env.branchState(branch);
  } catch {
    return { block: true, reason: `Slipway: could not check the Slipway PR for "${branch}" (is Slipway running? \`slipway up\`). Until then, ${PUSH_HINT}.` };
  }
  if (state === 'closed') return { block: false };
  if (state === 'open') {
    return { block: true, reason: `Slipway: "${branch}" has an open Slipway PR, so ${what} must go through Slipway first: ${PUSH_HINT} (slipway_push, slipway_update_pr, slipway_promote).` };
  }
  return { block: true, reason: `Slipway: "${branch}" has no Slipway PR yet, so ${what} would skip the local review: ${PUSH_HINT}, then slipway_open_pr.` };
}

export async function decide(input: HookInput, env: HookEnv): Promise<Decision> {
  if (input.tool_name !== 'Bash') return { block: false };
  const command = input.tool_input.command ?? '';
  if (!command || !env.isRegistered(input.cwd)) return { block: false };

  // ~/.slipway/config.json and the native Gitea's secrets (app.ini, secrets.json).
  if (/\.slipway\/(config\.json|gitea\/(app\.ini|secrets\.json))/.test(command)) {
    return { block: true, reason: 'Slipway: do not read Slipway credentials. Use the slipway_* tools instead.' };
  }
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const w = words(segment);
    let d: Decision = { block: false };
    const exe = (w[0] ?? '').split('/').pop();
    if (w[0] === 'git') {
      const i = gitSubcommandIndex(w);
      if (i > 0 && w[i] === 'push') {
        const branches = pushedBranches(w.slice(i + 1));
        if (branches === 'all') {
          d = { block: true, reason: `Slipway: pushing many branches or tags at once is not covered by a Slipway PR. Push one branch at a time; in this repo, ${PUSH_HINT}.` };
        } else {
          for (const b of branches) {
            d = await judgeBranch(b ?? env.currentBranch(), 'pushing it', env);
            if (d.block) break;
          }
        }
      }
    } else if ((exe === 'slipway' && w[1] === 'promote') || exe === 'promote.sh') {
      d = { block: true, reason: 'Slipway: promotion from the shell is for the user. Use the slipway_promote tool (it requires the user\'s approval).' };
    } else if (w[0] === 'gh' && w[1] === 'pr' && GH_PR_WRITES.has(w[2] ?? '')) {
      const args = w.slice(3);
      let branch: string | null;
      if (w[2] === 'create') {
        branch = ghCreateHead(args) ?? env.currentBranch();
      } else {
        const sel = ghPrSelector(args);
        branch = sel === null ? env.currentBranch() : await env.githubPrHead(sel).catch(() => null);
      }
      d = await judgeBranch(branch, `"gh pr ${w[2]}"`, env);
    } else if (w[0] === 'gh' && w[1] === 'api' && ghApiWrites(w, command, input.cwd)) {
      d = await judgeBranch(env.currentBranch(), 'writing to GitHub through "gh api"', env);
    }
    if (d.block) return d;
  }
  return { block: false };
}

/** Real environment: Gitea for the Slipway PR state, `gh` for GitHub PR heads. */
export function hookEnv(config: SlipwayConfig, repo: { name: string; branch: string | null; worktree: string }): HookEnv {
  const token = config.claude?.token ?? config.reviewer.token;
  const gitea = new GiteaClient(config.giteaUrl, token);
  return {
    isRegistered: () => true,
    currentBranch: () => repo.branch,
    async branchState(branch) {
      const pulls = await gitea.listPulls(config.org, repo.name, 'all');
      const mine = pulls.filter((p) => p.head.ref === branch);
      if (mine.some((p) => p.state === 'open')) return 'open';
      return mine.length ? 'closed' : 'none';
    },
    async githubPrHead(ref) {
      const r = await run('gh', ['pr', 'view', ref, '--json', 'headRefName', '-q', '.headRefName'], { cwd: repo.worktree, timeoutMs: 15_000 });
      return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    },
  };
}

/** Entry point for the bundled hook: reads the hook JSON on stdin, exits 2 with the reason when blocking. */
export async function main(): Promise<void> {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let input: HookInput;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // never break the session on malformed input
  }
  let config: SlipwayConfig;
  try {
    config = loadConfig();
  } catch {
    return; // Slipway not set up: nothing to guard
  }
  const repo = await resolveRepo(input.cwd, config).catch(() => undefined);
  if (!repo) return; // not a Slipway repo
  const d = await decide(input, hookEnv(config, repo));
  if (d.block) {
    process.stderr.write(d.reason + '\n');
    process.exit(2);
  }
}
