import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { loadConfig, slipwayHome, type SlipwayConfig } from '../config.ts';
import { GiteaClient } from '../gitea/client.ts';
import { run } from '../util/exec.ts';
import { resolveRepo } from './context.ts';
import { parseCommand, type SimpleCommand } from './shell.ts';
import { WORKTREES_DIR } from './start-task.ts';

/**
 * PreToolUse guard for Bash in Slipway repos: stops habits that would skip the local review (publishing code or a PR on
 * GitHub, promoting from the shell, reading Slipway credentials). A guardrail against mistakes, not a security boundary
 * (ADR 0003, 0009, 0013).
 *
 * Only what publishes code or a PR is guarded: `git push` to GitHub, `gh pr create/ready/merge`, and the `gh api` endpoints
 * and GraphQL mutations that do the same. Reviews, comments, labels, issues and other API writes pass. A guarded write is
 * judged by its branch's Slipway PR:
 * - only closed PRs (promoted, or deliberately closed) → allowed, the branch now lives on GitHub;
 * - an open PR → denied, the work goes through Slipway first;
 * - no PR → denied for the session's own task branch (a Slipway worktree), else the user is asked: a hotfix on main, a
 *   colleague's PR, a branch from outside Slipway are the user's call.
 * Whatever cannot be told (tags, deletions, many branches, detached HEAD, Slipway down) is asked, never silently allowed.
 */
export interface HookInput {
  tool_name: string;
  tool_input: { command?: string };
  cwd: string;
}

/** `ask` prompts the user with the reason; `deny` blocks and tells Claude. */
export type Decision = { action: 'allow' } | { action: 'ask' | 'deny'; reason: string };
const ALLOW: Decision = { action: 'allow' };

/** State of a branch in Slipway: `open` if any PR for it is open, `closed` if it has only closed PRs. */
export type BranchState = 'open' | 'closed' | 'none';

export interface HookEnv {
  isRegistered(cwd: string): boolean;
  /** Current branch of the session's worktree, null on detached HEAD. */
  currentBranch(): string | null;
  /** True when the session works in a Slipway task worktree (`.slipway/worktrees/…`): its branch is the agent's task. */
  inTaskWorktree(): boolean;
  /** Slipway PR state for a branch; throws when Slipway cannot be asked. */
  branchState(branch: string): Promise<BranchState>;
  /** Head branch of a GitHub PR given by number, URL or branch (as `gh pr <cmd> <arg>` takes it); null if unknown. */
  githubPrHead(ref: string): Promise<string | null>;
  /**
   * Whether `git push <remote>` (`remote` null: the current branch's push remote) goes to GitHub: the URL of `origin` (where
   * promotion pushes), anything that looks like GitHub, or a URL that cannot be found (fail closed).
   */
  pushesToGitHub(remote: string | null): Promise<boolean>;
  /** Absolute paths of Slipway's credential files (config, native Gitea secrets, Docker env file). */
  credentialFiles(): string[];
}

/** `gh pr` commands that publish a PR or its code (open it, take it out of draft, merge it). */
const GH_PR_PUBLISH = new Set(['create', 'ready', 'merge']);
/** `git push` options that take a separate value. */
const PUSH_OPTS_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
/** `gh pr` options that take a separate value (the positional PR selector must not be confused with them). */
const GH_PR_OPTS_WITH_VALUE = new Set(['-R', '--repo', '-t', '--title', '-b', '--body', '-F', '--body-file', '-B', '--base', '-H', '--head',
  '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-p', '--project', '-r', '--reviewer', '--add-label', '--remove-label',
  '--add-assignee', '--remove-assignee', '--add-reviewer', '--remove-reviewer', '--add-project', '--remove-project', '-c', '--comment',
  '--template', '--recover', '--subject', '--author-email', '--match-head-commit', '--delete-branch-on-merge']);

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

/** The first positional argument, skipping options (and the separate values of `optsWithValue`); null if there is none. */
function firstPositional(args: string[], optsWithValue: Set<string>): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (optsWithValue.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    return a;
  }
  return null;
}

const ghApiEndpoint = (w: string[]) => firstPositional(w.slice(2), GH_API_OPTS_WITH_VALUE);

/**
 * A GraphQL document with its string literals and comments blanked out, and whether it defines a mutation operation
 * (`mutation` at the top level, not inside a selection set, a string or a comment).
 */
function readGraphql(doc: string): { text: string; mutation: boolean } {
  let text = '';
  let depth = 0;
  let mutation = false;
  for (let i = 0; i < doc.length; i++) {
    const c = doc[i]!;
    if (c === '#') { while (i + 1 < doc.length && doc[i + 1] !== '\n') i++; text += ' '; continue; }
    if (c === '"') {
      const block = doc.startsWith('"""', i);
      const end = block ? doc.indexOf('"""', i + 3) : (() => {
        for (let j = i + 1; j < doc.length; j++) { if (doc[j] === '\\') j++; else if (doc[j] === '"' || doc[j] === '\n') return j; }
        return -1;
      })();
      i = end < 0 ? doc.length : end + (block ? 2 : 0);
      text += '""';
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[A-Za-z_]/.test(c) && !/[\w$]/.test(doc[i - 1] ?? '')) {
      const word = /^[A-Za-z_]\w*/.exec(doc.slice(i))![0];
      if (word === 'mutation') mutation = true;
      text += word;
      i += word.length - 1;
      continue;
    }
    text += c;
  }
  return { text, mutation };
}

/** A GraphQL request body may be JSON (`{"query": "…"}`): its query, else the text itself. */
function graphqlDocument(source: string): string {
  try {
    const j = JSON.parse(source) as unknown;
    if (j && typeof j === 'object' && typeof (j as { query?: unknown }).query === 'string') return (j as { query: string }).query;
  } catch { /* not JSON: a bare document */ }
  return source;
}

/** GraphQL mutations that publish code or a PR; any other mutation (reviews, comments, threads, labels…) passes. */
const PUBLISH_MUTATIONS = new Set(['createPullRequest', 'mergePullRequest', 'markPullRequestReadyForReview',
  'enablePullRequestAutoMerge', 'enqueuePullRequest', 'revertPullRequest', 'updatePullRequestBranch', 'mergeBranch',
  'createCommitOnBranch', 'createRef', 'updateRef', 'updateRefs']);

/**
 * GraphQL always goes out as POST, so the document decides. It comes from the `query` field (`-f query=…`, `-F query=@file`),
 * the request body (`--input file`, or a heredoc for `--input -`, JSON or a bare document). Only a mutation operation counts:
 * `mutation` in a string, a comment, a `--jq` filter or another field is not one. It publishes when the mutation has a field
 * from PUBLISH_MUTATIONS; an unreadable file, or a mutation whose fields cannot be told, counts as publishing (fail closed).
 * GitHub mutations all take `input:`, which is how their names are found.
 */
export function graphqlPublishes(cmd: SimpleCommand, cwd: string): boolean {
  const w = cmd.words;
  const sources: string[] = [];
  const files: string[] = [];
  let stdin = false;
  for (let i = 2; i < w.length; i++) {
    const a = w[i]!;
    let input: string | null = null;
    if (a === '--input') input = w[++i] ?? '';
    else if (a.startsWith('--input=')) input = a.slice('--input='.length);
    if (input !== null) {
      if (input === '-') stdin = true;
      else files.push(input);
      continue;
    }
    let field: string | null = null;
    if (['-f', '-F', '--field', '--raw-field'].includes(a)) field = w[++i] ?? '';
    else if (/^--(raw-)?field=/.test(a)) field = a.slice(a.indexOf('=') + 1);
    if (field === null || !field.startsWith('query=')) continue;
    const value = field.slice('query='.length);
    if (a !== '-f' && a !== '--raw-field' && !a.startsWith('--raw-field=') && value.startsWith('@')) {
      if (value === '@-') stdin = true;
      else files.push(value.slice(1));
    } else {
      sources.push(value);
    }
  }
  if (stdin) sources.push(...cmd.heredocs);
  for (const f of files) {
    try {
      sources.push(readFileSync(resolve(cwd, f.replace(/^~(?=\/)/, homedir())), 'utf8'));
    } catch {
      return true;
    }
  }
  for (const source of sources) {
    const { text, mutation } = readGraphql(graphqlDocument(source));
    if (!mutation) continue;
    const names = [...text.matchAll(/\b([A-Za-z_]\w*)\s*\(\s*input\s*:/g)].map((m) => m[1]!);
    if (names.length === 0 || names.some((n) => PUBLISH_MUTATIONS.has(n))) return true;
  }
  return false;
}

/** The HTTP method `gh api` uses: the explicit one, else POST when it sends fields or a body, else GET. */
function ghApiMethod(w: string[]): string {
  let fields = false;
  for (let i = 2; i < w.length; i++) {
    const a = w[i]!;
    if (a === '-X' || a === '--method') return (w[i + 1] ?? '').toUpperCase();
    const m = /^(?:-X|--method=)([A-Za-z]+)$/.exec(a);
    if (m) return m[1]!.toUpperCase();
    if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a) || /^--(raw-)?field=/.test(a)) fields = true;
  }
  return fields ? 'POST' : 'GET';
}

/**
 * REST endpoints that publish code or a PR: open or merge a PR, update its branch, merge branches, write refs or files.
 * Bare git objects (`git/commits|trees|blobs|tags`) publish nothing until a ref points at them, and that write is guarded.
 */
export function restPublishes(endpoint: string, method: string): boolean {
  if (method === 'GET' || method === 'HEAD') return false;
  const path = endpoint.replace(/^\/+/, '').replace(/\?.*$/, '');
  const m = /^repos\/[^/]+\/[^/]+\/(.*)$/.exec(path);
  if (!m) return false;
  const rest = m[1]!.replace(/\/+$/, '');
  if (rest === 'pulls') return method === 'POST';
  return /^(pulls\/\d+\/(merge|update-branch)|merges|git\/refs(\/.*)?|contents\/.+)$/.test(rest);
}

/** The value of a `gh api` field (`-f name=…`, `-F name=…`, `--field=name=…`), or null. */
function ghApiField(w: string[], name: string): string | null {
  for (let i = 2; i < w.length; i++) {
    const a = w[i]!;
    let field: string | undefined;
    if (['-f', '-F', '--field', '--raw-field'].includes(a)) field = w[++i];
    else if (/^--(raw-)?field=/.test(a)) field = a.slice(a.indexOf('=') + 1);
    if (field?.startsWith(name + '=')) return field.slice(name.length + 1);
  }
  return null;
}

/** A `head` value without its fork owner (`owner:branch` → `branch`). */
const stripOwner = (head: string) => head.slice(head.indexOf(':') + 1) || null;

/**
 * What a publishing `gh api` call writes to. `pr`: a PR it names (`pulls/N/merge|update-branch`, as a `gh pr` selector).
 * `branch`: the branch whose code it publishes (`head` of a new PR or a merge, the `branch` of a file write, the ref it
 * creates, updates or deletes); `current` means the session's branch (GraphQL, whose target cannot be told). `unknown`
 * says why no branch can be told (a tag, a default branch, bare git objects): then the user is asked.
 */
type ApiTarget = { pr: string } | { branch: string | 'current'; deleting?: boolean } | { unknown: string };

function ghApiPublishes(cmd: SimpleCommand, cwd: string): ApiTarget | null {
  const w = cmd.words;
  const endpoint = ghApiEndpoint(w);
  if (endpoint === 'graphql') return graphqlPublishes(cmd, cwd) ? { branch: 'current' } : null;
  const method = ghApiMethod(w);
  if (endpoint === null || !restPublishes(endpoint, method)) return null;
  const m = /^\/?repos\/([^/]+)\/([^/]+)\/(.*?)\/*(?:\?.*)?$/.exec(endpoint);
  if (!m) return null;
  const [, owner, repo, rest] = m as unknown as [string, string, string, string];
  const pull = /^pulls\/(\d+)\/(merge|update-branch)$/.exec(rest);
  if (pull) return { pr: owner === '{owner}' && repo === '{repo}' ? pull[1]! : `https://github.com/${owner}/${repo}/pull/${pull[1]}` };
  if (rest === 'pulls') {
    const head = ghApiField(w, 'head');
    if (head === null) return { branch: 'current' }; // gh api requires a head; without one, judge the session's branch
    const branch = stripOwner(head);
    return branch ? { branch } : { unknown: 'a PR without a head branch' };
  }
  if (rest === 'merges') {
    const head = ghApiField(w, 'head');
    return head ? { branch: head } : { unknown: 'a merge without a head branch' };
  }
  if (rest.startsWith('contents/')) {
    const branch = ghApiField(w, 'branch');
    return branch ? { branch } : { unknown: 'a file write to the default branch' };
  }
  const ref = rest === 'git/refs' ? (ghApiField(w, 'ref') ?? '') : /^git\/refs\/(.+)$/.exec(rest)?.[1] ?? null;
  if (ref !== null) {
    const name = ref.replace(/^refs\//, '');
    if (!name.startsWith('heads/')) return { unknown: `a write to the ref "${name || '?'}"` };
    return { branch: name.slice('heads/'.length), deleting: method === 'DELETE' };
  }
  return null;
}

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
    positional.push(a);
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
export const ghPrSelector = (args: string[]) => firstPositional(args, GH_PR_OPTS_WITH_VALUE);

/** For `gh pr create`: the `--head` branch without its fork owner (`owner:branch`), or null for the current branch. */
function ghCreateHead(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-H' || a === '--head') return stripOwner(args[i + 1] ?? '');
    if (a.startsWith('--head=')) return stripOwner(a.slice('--head='.length));
  }
  return null;
}

/** The remote a `git push` names (its first positional argument), or null for the default push remote. */
export const pushRemote = (args: string[]) => firstPositional(args, PUSH_OPTS_WITH_VALUE);

const PUSH_HINT = 'push with the slipway_push tool (it pushes to the local review Gitea); GitHub gets the branch through promotion';
const ASK_TAIL = 'Allow it only if you want it on GitHub without the local review.';

/**
 * A publishing write on `branch` (null: it cannot be told, e.g. a detached HEAD or an unknown PR head), described to the
 * user as `what`. A branch whose Slipway PRs are all closed passes; an open PR denies; without a PR the session's own task
 * branch (current branch in a Slipway worktree) is denied and any other branch is asked. `deleting`: the write deletes the
 * branch, which is asked even for an open Slipway PR (it publishes nothing).
 */
async function judgeBranch(branch: string | null, what: string, env: HookEnv, opts: { deleting?: boolean } = {}): Promise<Decision> {
  if (!branch) {
    return { action: 'ask', reason: `Slipway: cannot tell which branch ${what} targets (detached HEAD, or an unknown PR?). ${ASK_TAIL}` };
  }
  let state: BranchState;
  try {
    state = await env.branchState(branch);
  } catch {
    return { action: 'ask', reason: `Slipway could not check the Slipway PR for "${branch}" (is it running? \`slipway up\`). ${ASK_TAIL}` };
  }
  if (state === 'closed') return ALLOW;
  if (opts.deleting) return { action: 'ask', reason: `Slipway: ${what} deletes "${branch}" on GitHub. Allow it only if that branch is no longer needed there.` };
  if (state === 'open') {
    return { action: 'deny', reason: `Slipway: "${branch}" has an open Slipway PR, so ${what} must go through Slipway first: ${PUSH_HINT} (slipway_push, slipway_update_pr, slipway_promote).` };
  }
  if (branch === env.currentBranch() && env.inTaskWorktree()) {
    return { action: 'deny', reason: `Slipway: "${branch}" is this task's branch and has no Slipway PR yet, so ${what} would skip the local review: ${PUSH_HINT}, then slipway_open_pr.` };
  }
  return { action: 'ask', reason: `Slipway: "${branch}" has no Slipway PR, so ${what} publishes it on GitHub without the local review. ${ASK_TAIL}` };
}

/** Path-like runs ending in a credential file name, anywhere in a word (`$(cat …)`, `require('…')`, `--file=…`). */
const CREDENTIAL_PATH = /[^\s'"`;|&<>(),=@:]*(?:config\.json|app\.ini|secrets\.json|gitea\.env)(?![\w.-])/g;
const expandHome = (p: string) => p.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());

/**
 * True when a command names one of Slipway's credential files: `~`, `$HOME` and relative paths resolved against the
 * session's cwd as moved by earlier `cd`s in the same command. Paths are matched by where they point, so a search pattern
 * or a repo file with the same name does not count.
 */
function readsCredentials(cmds: SimpleCommand[], cwd: string, env: HookEnv): boolean {
  const files = new Set(env.credentialFiles().flatMap((f) => [f, realOrSelf(f)]));
  let dir = cwd;
  for (const c of cmds) {
    if (c.words[0] === 'cd' && !c.words.includes('-')) { // `cd -`: the previous directory is not known
      const to = c.words.slice(1).find((a) => !a.startsWith('-'));
      if (to === undefined) dir = homedir();
      else if (!to.includes('$(') && !to.includes('`')) dir = resolve(dir, expandHome(to));
    }
    for (const w of [...c.words, ...c.redirects]) {
      for (const [p] of w.matchAll(CREDENTIAL_PATH)) {
        const abs = resolve(dir, expandHome(p));
        if (files.has(abs) || files.has(realOrSelf(abs))) return true;
      }
    }
  }
  return false;
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The decision for one simple command. */
async function judgeCommand(c: SimpleCommand, cwd: string, env: HookEnv): Promise<Decision> {
  const w = c.words;
  const exe = (w[0] ?? '').split('/').pop();
  if (w[0] === 'git') {
    const i = gitSubcommandIndex(w);
    if (i < 0 || w[i] !== 'push') return ALLOW;
    const args = w.slice(i + 1);
    if (args.includes('-n') || args.includes('--dry-run')) return ALLOW;
    if (!(await env.pushesToGitHub(pushRemote(args)).catch(() => true))) return ALLOW; // the review Gitea, a deploy remote…
    const branches = pushedBranches(args);
    if (branches === 'all') {
      return { action: 'ask', reason: `Slipway: this push publishes tags or several branches at once, which no Slipway PR covers. ${ASK_TAIL}` };
    }
    const deleting = args.includes('-d') || args.includes('--delete') || args.some((a) => /^\+?:/.test(a));
    let ask: Decision | null = null;
    for (const b of branches) {
      const d = await judgeBranch(b ?? env.currentBranch(), deleting ? 'this push' : 'pushing it', env, { deleting });
      if (d.action === 'deny') return d;
      if (d.action === 'ask') ask ??= d;
    }
    return ask ?? ALLOW;
  }
  if ((exe === 'slipway' && w[1] === 'promote') || exe === 'promote.sh') {
    return { action: 'deny', reason: 'Slipway: promotion from the shell is for the user. Use the slipway_promote tool (it requires the user\'s approval).' };
  }
  if (w[0] === 'gh' && w[1] === 'pr' && GH_PR_PUBLISH.has(w[2] ?? '')) {
    const args = w.slice(3);
    let branch: string | null;
    if (w[2] === 'create') {
      branch = ghCreateHead(args) ?? env.currentBranch();
    } else {
      const sel = ghPrSelector(args);
      branch = sel === null ? env.currentBranch() : await env.githubPrHead(sel).catch(() => null);
    }
    return judgeBranch(branch, `"gh pr ${w[2]}"`, env);
  }
  if (w[0] === 'gh' && w[1] === 'api') {
    const p = ghApiPublishes(c, cwd);
    if (!p) return ALLOW;
    const what = 'this "gh api" call';
    if ('unknown' in p) return { action: 'ask', reason: `Slipway: ${what} is ${p.unknown}, which no Slipway PR covers. ${ASK_TAIL}` };
    if ('pr' in p) return judgeBranch(await env.githubPrHead(p.pr).catch(() => null), what, env);
    return judgeBranch(p.branch === 'current' ? env.currentBranch() : p.branch, what, env, { deleting: p.deleting });
  }
  return ALLOW;
}

export async function decide(input: HookInput, env: HookEnv): Promise<Decision> {
  if (input.tool_name !== 'Bash') return ALLOW;
  const command = input.tool_input.command ?? '';
  if (!command || !env.isRegistered(input.cwd)) return ALLOW;
  const cmds = parseCommand(command);
  if (readsCredentials(cmds, input.cwd, env)) {
    return { action: 'deny', reason: 'Slipway: do not read Slipway credentials. Use the slipway_* tools instead.' };
  }
  let ask: Decision | null = null;
  for (const c of cmds) {
    const d = await judgeCommand(c, input.cwd, env);
    if (d.action === 'deny') return d;
    if (d.action === 'ask') ask ??= d;
  }
  return ask ?? ALLOW;
}

type RepoInfo = { name: string; branch: string | null; worktree: string; entry: { path: string } };

/** Real environment: Gitea for the Slipway PR state, `gh` for GitHub PR heads, git for push remotes. */
export function hookEnv(config: SlipwayConfig, repo: RepoInfo): HookEnv {
  const token = config.claude?.token ?? config.reviewer.token;
  // A hung Gitea must not hold every push for the hook's whole timeout: give up after 5 s and ask.
  const gitea = new GiteaClient(config.giteaUrl, token, (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(5_000) }));
  let states: Promise<Map<string, BranchState>> | undefined;
  const git = async (...args: string[]) => {
    const r = await run('git', args, { cwd: repo.worktree, timeoutMs: 5_000 });
    return r.code === 0 ? r.stdout.trim() || null : null;
  };
  const tasks = realOrSelf(join(repo.entry.path, WORKTREES_DIR)) + sep;
  return {
    isRegistered: () => true,
    currentBranch: () => repo.branch,
    inTaskWorktree: () => (realOrSelf(repo.worktree) + sep).startsWith(tasks),
    async branchState(branch) {
      // One listing per hook run, however many branches and subcommands the command has.
      states ??= gitea.listPulls(config.org, repo.name, 'all').then((pulls) => {
        const m = new Map<string, BranchState>();
        for (const p of pulls) if (m.get(p.head.ref) !== 'open') m.set(p.head.ref, p.state === 'open' ? 'open' : 'closed');
        return m;
      });
      return (await states).get(branch) ?? 'none';
    },
    async githubPrHead(ref) {
      const r = await run('gh', ['pr', 'view', ref, '--json', 'headRefName', '-q', '.headRefName'], { cwd: repo.worktree, timeoutMs: 15_000 });
      return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    },
    async pushesToGitHub(remote) {
      let name = remote;
      if (name === null) { // the default push remote, read from one `git config --list`
        const cfg = new Map<string, string>();
        for (const entry of ((await git('config', '-z', '--list')) ?? '').split('\0')) {
          const nl = entry.indexOf('\n');
          if (nl > 0) cfg.set(entry.slice(0, nl), entry.slice(nl + 1));
        }
        const b = repo.branch;
        name = (b && cfg.get(`branch.${b}.pushremote`)) || cfg.get('remote.pushdefault') || (b && cfg.get(`branch.${b}.remote`)) || 'origin';
      }
      if (name === 'origin') return true; // promotion pushes there
      const url = /[:/]/.test(name) ? name : await git('remote', 'get-url', '--push', name); // a URL or path, else a remote name
      if (url === null) return true;
      // GitHub, including SSH host aliases such as `github-work:org/repo`, or wherever origin points.
      return /github/i.test(url) || url === (await git('remote', 'get-url', '--push', 'origin'));
    },
    credentialFiles: () => {
      const home = slipwayHome();
      return [join(home, 'config.json'), join(home, 'gitea', 'app.ini'), join(home, 'gitea', 'secrets.json'), join(home, 'docker', 'gitea.env')];
    },
  };
}

/**
 * Entry point for the bundled hook: reads the hook JSON on stdin. `deny` exits 2 with the reason on stderr (Claude reads it);
 * `ask` prints a PreToolUse permission decision so the user is prompted with the reason.
 */
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
  if (d.action === 'deny') {
    process.stderr.write(d.reason + '\n');
    process.exit(2);
  }
  if (d.action === 'ask') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: d.reason } }) + '\n');
  }
}
