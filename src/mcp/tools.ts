import { slipwayEnv } from '../env.ts';
import { hostname as osHostname } from 'node:os';
import { loadConfig, saveConfig, type Account, type SlipwayConfig } from '../config.ts';
import { approvalOf, type Approval } from '../core/approval.ts';
import { GiteaClient } from '../gitea/client.ts';
import type { GComment, GPull } from '../gitea/types.ts';
import { defaultPromoteDeps } from '../promote/cli.ts';
import { githubToken } from '../promote/github-token.ts';
import { EXIT, promote as runPromote, type PromoteOptions, type PromoteResult } from '../promote/promote.ts';
import { basicAuthArgs } from '../util/git-auth.ts';
import { collectConventions } from './conventions.ts';
import { resolveRepo, type RepoContext } from './context.ts';
import { GiteaError } from '../gitea/client.ts';
import { claudeUsername, ensureClaudeUser, giteaAdmin, resetEnrollmentCache, type GiteaAdminPort } from './enroll.ts';
import { startTaskWorktree } from './start-task.ts';
import { pushBranch, type PushOptions } from './push.ts';
import { syncBase, type SyncBaseOptions } from '../setup/sync.ts';
import { ensureRunning } from '../runtime/index.ts';

export interface ToolResult { text: string; isError?: boolean }

export interface ToolDeps {
  loadConfig: () => SlipwayConfig;
  saveConfig: (c: SlipwayConfig) => void;
  hostname: () => string;
  gitea: (config: SlipwayConfig, token: string) => GiteaClient;
  admin: (config: SlipwayConfig) => GiteaAdminPort;
  resolveRepo: (cwd: string, config: SlipwayConfig) => Promise<RepoContext>;
  githubToken: () => Promise<string>;
  /** Mirrors GitHub's base into Slipway's base (as Slipway's admin). */
  syncBase: (o: SyncBaseOptions) => Promise<void>;
  pushBranch: (o: PushOptions) => Promise<{ ok: boolean; message: string }>;
  promote: (opts: PromoteOptions, ctx: { config: SlipwayConfig; actor: Account; token: string }) => Promise<PromoteResult>;
  /** Starts the native Gitea if it is down (e.g. after a reboot, ADR 0002). */
  ensureGitea?: () => Promise<void>;
}

export const defaultToolDeps: ToolDeps = {
  loadConfig,
  saveConfig,
  hostname: osHostname,
  gitea: (config, token) => new GiteaClient(config.giteaUrl, token),
  admin: giteaAdmin,
  resolveRepo,
  githubToken: () => githubToken(),
  syncBase,
  pushBranch,
  promote: (opts, ctx) => runPromote(opts, defaultPromoteDeps((m) => console.error(`slipway: ${m}`), ctx.token, ctx.actor)),
  ensureGitea: ensureRunning,
};

interface Session {
  config: SlipwayConfig;
  repo: RepoContext;
  claude: Account;
  gitea: GiteaClient;
  /** Gitea owner of the review repos (the org). */
  owner: string;
  /** The human reviewer whose approval counts. */
  approver: string;
}

export interface CwdArg { cwd?: string }

let identityChecked = false;
/** Test hook: re-validate the saved Claude identity on the next call. */
export function resetIdentityCheck(): void {
  identityChecked = false;
}

const cwdOf = (a: CwdArg) => a.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

async function session(args: CwdArg, d: ToolDeps): Promise<Session> {
  let config: SlipwayConfig;
  try {
    config = d.loadConfig();
  } catch {
    throw new Error('Slipway is not set up. Ask the user to run: slipway init');
  }
  const repo = await d.resolveRepo(cwdOf(args), config);
  await d.ensureGitea?.();
  // A saved identity Gitea no longer accepts (e.g. the instance was reset) is dropped and re-enrolled.
  if (config.claude && !identityChecked) {
    try {
      await d.gitea(config, config.claude.token).req('GET', '/user');
    } catch (e) {
      if (!(e instanceof GiteaError && (e.status === 401 || e.status === 403))) throw e;
      delete config.claude;
      d.saveConfig(config);
      resetEnrollmentCache();
    }
    identityChecked = true;
  }
  // Build the admin port only when enrollment is actually needed.
  const claude = config.claude ?? await ensureClaudeUser(config, {
    admin: d.admin(config),
    save: d.saveConfig,
    reload: d.loadConfig,
    username: claudeUsername(d.hostname(), slipwayEnv('CLAUDE_USER')),
  });
  return { config, repo, claude, gitea: d.gitea(config, claude.token), owner: config.org, approver: config.reviewer.username };
}

/** Runs a tool body; any thrown error becomes a readable tool error (never a stack trace with secrets). */
async function tool(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { text: await fn() };
  } catch (e) {
    return { text: (e as Error).message, isError: true };
  }
}

async function findPr(s: Session, pr?: number): Promise<GPull> {
  if (pr) return s.gitea.getPull(s.owner, s.repo.name, pr);
  const open = await s.gitea.listPulls(s.owner, s.repo.name, 'open');
  const mine = open.find((p) => p.head.ref === s.repo.branch);
  if (mine) return mine;
  const others = open.map((p) => `#${p.number} ${p.title} (${p.head.ref})`).join('\n') || '(none)';
  throw new Error(`No open Slipway PR for branch ${s.repo.branch ?? '(detached)'}. Pass "pr". Open PRs:\n${others}`);
}

function approvalFor(s: Session, p: GPull): Promise<Approval> {
  return approvalOf(s.gitea, s.owner, s.repo.name, p, s.approver);
}

/** State with the reason when an approval stopped counting (base changed, unreadable timeline). */
function describeState(a: Approval): string {
  if (a.warning) return `${a.state} (warning: ${a.warning})`;
  if (a.baseChangedAfterApproval) return `${a.state} (approved before the base changed: needs a fresh approval)`;
  return a.state;
}

const PROMOTED = '🚢 Promoted to GitHub:';
const promotedLink = (comments: GComment[]) => comments.find((c) => c.body.startsWith(PROMOTED))?.body.slice(PROMOTED.length).trim();

/** A new base must exist in Slipway and differ from the head (Gitea itself accepts base == head). */
async function checkBase(s: Session, head: string, base: string): Promise<void> {
  if (base === head) throw new Error(`The base cannot be the PR's own branch (${head}).`);
  if (!(await s.gitea.branchExists(s.owner, s.repo.name, base))) {
    throw new Error(`Branch "${base}" does not exist in Slipway. Push it first (slipway_push from its worktree) or pick another base.`);
  }
}

/**
 * Brings Slipway's base branch up to date with GitHub before work is pushed, so PR diffs are against the current
 * main (merged promotions included). Never blocks: on failure it returns a warning line for the tool result.
 */
async function syncSlipwayBase(s: Session, d: ToolDeps): Promise<string> {
  try {
    await d.syncBase({
      repoDir: s.repo.entry.path, base: s.repo.entry.base, giteaRepoUrl: giteaUrlOf(s),
      authArgs: basicAuthArgs(s.config.admin.username, s.config.admin.token),
    });
    return '';
  } catch (e) {
    return `\nWarning: Slipway ${s.repo.entry.base} was not updated from GitHub (${(e as Error).message}). The PR diff may include commits already on GitHub.`;
  }
}

function giteaUrlOf(s: Session): string {
  return `${s.config.giteaUrl.replace(/\/$/, '')}/${s.owner}/${s.repo.name}.git`;
}

// ---- tools ---------------------------------------------------------------------------------------

export function status(args: CwdArg, d: ToolDeps = defaultToolDeps): Promise<ToolResult> {
  return tool(async () => {
    const s = await session(args, d);
    const version = await s.gitea.version().then((v) => v.version, () => 'unreachable');
    const lines = [
      `Gitea: ${s.config.giteaUrl} (${version})`,
      `Repo: ${s.repo.name} (GitHub ${s.repo.entry.github}, base ${s.repo.entry.base})`,
      `You are Gitea user: ${s.claude.username}`,
      `Branch: ${s.repo.branch ?? '(detached HEAD)'}`,
    ];
    const open = await s.gitea.listPulls(s.owner, s.repo.name, 'open');
    const pr = open.find((p) => p.head.ref === s.repo.branch);
    if (pr) {
      const unresolved = await s.gitea.unresolvedComments(s.owner, s.repo.name, pr.number, s.claude.username);
      lines.push(`PR: #${pr.number} "${pr.title}" ${pr.html_url}`, `Base: ${pr.base.ref}`, `State: ${describeState(await approvalFor(s, pr))}`, `Unresolved review comments: ${unresolved.length}`);
    } else {
      lines.push('PR: none for this branch');
    }
    return lines.join('\n');
  });
}

export function repoConventions(args: CwdArg, d: ToolDeps = defaultToolDeps): Promise<ToolResult> {
  return tool(async () => {
    const config = d.loadConfig();
    const repo = await d.resolveRepo(cwdOf(args), config);
    const c = collectConventions(repo.worktree);
    const header = c.usedFallbackTemplate
      ? 'This repo has no PR template; use the Slipway default template below unless the other rules say otherwise.'
      : 'Follow these repository rules for the PR title and description. The repo rules win over any Slipway default.';
    const branches = 'Branch names: if these rules define a branch naming scheme, name the task branch by it (slipway_start_task `branch`); otherwise leave `branch` out and Slipway uses agent/<task_id>-<slug>.';
    return [header, branches, ...c.items.map((i) => `\n===== ${i.source} =====\n${i.content}`)].join('\n');
  });
}

export function push(args: CwdArg & { force_with_lease?: boolean }, d: ToolDeps = defaultToolDeps): Promise<ToolResult> {
  return tool(async () => {
    const s = await session(args, d);
    const warning = await syncSlipwayBase(s, d);
    const r = await d.pushBranch({
      worktree: s.repo.worktree, repoDir: s.repo.entry.path, url: giteaUrlOf(s),
      authArgs: basicAuthArgs(s.claude.username, s.claude.token), base: s.repo.entry.base, branch: s.repo.branch, force: !!args.force_with_lease,
    });
    if (!r.ok) throw new Error(r.message + warning);
    return r.message + (args.force_with_lease ? '\nThe head changed: the PR needs a fresh approval from the user.' : '') + warning;
  });
}

export function openPr(args: CwdArg & { title: string; body: string; base?: string }, d: ToolDeps = defaultToolDeps): Promise<ToolResult> {
  return tool(async () => {
    const s = await session(args, d);
    if (args.base !== undefined) await checkBase(s, s.repo.branch ?? '', args.base);
    const warning = await syncSlipwayBase(s, d);
    const pushed = await d.pushBranch({
      worktree: s.repo.worktree, repoDir: s.repo.entry.path, url: giteaUrlOf(s),
      authArgs: basicAuthArgs(s.claude.username, s.claude.token), base: s.repo.entry.base, branch: s.repo.branch, force: false,
    });
    if (!pushed.ok) throw new Error(pushed.message + warning);
    const existing = (await s.gitea.listPulls(s.owner, s.repo.name, 'open')).find((p) => p.head.ref === s.repo.branch);
    if (existing) return `${pushed.message}\nPR #${existing.number} already exists: ${existing.html_url}\nUse slipway_update_pr to change its title/description.${warning}`;
    const pr = await s.gitea.createPull(s.owner, s.repo.name, { head: s.repo.branch!, base: args.base ?? s.repo.entry.base, title: args.title, body: args.body });
    return `${pushed.message}\nOpened PR #${pr.number}: ${pr.html_url}\nTell the user it is ready for review in Gitea.${warning}`;
  });
}

export function updatePr(args: CwdArg & { pr?: number; title?: string; body?: string; base?: string }, d: ToolDeps = defaultToolDeps): Promise<ToolResult> {
  return tool(async () => {
    if (args.title === undefined && args.body === undefined && args.base === undefined) throw new Error('Nothing to update: pass title, body and/or base.');
    const s = await session(args, d);
    const pr = await findPr(s, args.pr);
    if (pr.state !== 'open') throw new Error(`PR #${pr.number} is ${pr.state}: only open PRs can be changed.`);
    const before = await approvalFor(s, pr);
    if (before.approved && (args.title !== undefined || args.body !== undefined)) {
      throw new Error(`PR #${pr.number} is approved: its title/description are frozen for you, so nothing was changed. Ask the user to edit them in Gitea, or to request changes first.${args.base !== undefined ? ' To change only the base, call again with base alone.' : ''}`);
    }
    const retarget = args.base !== undefined && args.base !== pr.base.ref;
    if (retarget) await checkBase(s, pr.head.ref, args.base!);
    const patch: { title?: string; body?: string; base?: string } = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.body !== undefined) patch.body = args.body;
    if (retarget) patch.base = args.base;
    if (Object.keys(patch).length === 0) return `PR #${pr.number} already targets ${pr.base.ref}: nothing to change.`;
    await s.gitea.editPull(s.owner, s.repo.name, pr.number, patch);
    const lines = [`Updated PR #${pr.number}: ${pr.html_url}`];
    if (retarget) {
      const fresh = await s.gitea.getPull(s.owner, s.repo.name, pr.number);
      const commits = await s.gitea.pullCommits(s.owner, s.repo.name, pr.number).then((c) => `${c.length} commit(s), `, () => '');
      lines.push(`Base: ${pr.base.ref} → ${fresh.base.ref}. Diff now: ${commits}${fresh.changed_files ?? '?'} file(s) (+${fresh.additions ?? '?'}/−${fresh.deletions ?? '?'}).`);
      if (before.approved) lines.push('The approval no longer counts (the diff the user approved changed): ask the user to approve it again in Gitea.');
    }
    return lines.join('\n');
  });
}

export function closePr(args: CwdArg & { pr: number; reason: string }, d: ToolDeps = defaultToolDeps): Promise<ToolResult> {
  return tool(async () => {
    if (!args.reason?.trim()) throw new Error('Pass a reason (e.g. "Superseded by #7 and #8"); it is posted on the PR.');
    const s = await session(args, d);
    const pr = await s.gitea.getPull(s.owner, s.repo.name, args.pr);
    if (pr.state !== 'open') return `PR #${pr.number} is already ${pr.state}: nothing to do. ${pr.html_url}`;
    await s.gitea.comment(s.owner, s.repo.name, pr.number, `Closed by ${s.claude.username}: ${args.reason.trim()}`);
    await s.gitea.editPull(s.owner, s.repo.name, pr.number, { state: 'closed' });
    return `Closed PR #${pr.number} "${pr.title}": ${pr.html_url}\nThe user can reopen it in Gitea.`;
  });
}

export function listPrs(args: CwdArg & { state?: 'open' | 'closed' | 'all' }, d: ToolDeps = defaultToolDeps): Promise<ToolResult> {
  return tool(async () => {
    const s = await session(args, d);
    const state = args.state ?? 'open';
    const pulls = await s.gitea.listPulls(s.owner, s.repo.name, state);
    if (pulls.length === 0) return `No ${state === 'all' ? '' : state + ' '}Slipway PRs in ${s.repo.name}.`;
    const lines = await Promise.all(pulls.map(async (p) => {
      let st: string;
      let extra = '';
      if (p.state === 'open') {
        st = describeState(await approvalFor(s, p));
        const unresolved = await s.gitea.unresolvedComments(s.owner, s.repo.name, p.number, s.claude.username).then((u) => u.length, () => '?');
        extra = ` · unresolved: ${unresolved}`;
      } else {
        const link = promotedLink(await s.gitea.listComments(s.owner, s.repo.name, p.number).catch(() => []));
        st = link ? `promoted (${link})` : 'closed';
      }
      return `#${p.number} ${p.title} · ${p.head.ref} → ${p.base.ref} · ${st}${extra}${p.head.ref === s.repo.branch ? ' · (this branch)' : ''}`;
    }));
    return lines.join('\n');
  });
}

const DIFF_LIMIT = 100_000;
const short = (sha?: string) => (sha ?? '').slice(0, 8);
const indent = (text: string) => text.trim().split('\n').map((l) => `    ${l}`).join('\n');

function timelineLine(e: { type: string; created_at: string; user?: { login: string } | null; body?: string; old_ref?: string; new_ref?: string }): string | undefined {
  const who = e.user?.login ?? '?';
  switch (e.type) {
    case 'change_target_branch': return `${e.created_at} ${who}: base ${e.old_ref} → ${e.new_ref}`;
    case 'close': return `${e.created_at} ${who}: closed`;
    case 'reopen': return `${e.created_at} ${who}: reopened`;
    case 'pull_push': {
      let info: { is_force_push?: boolean; commit_ids?: string[] } = {};
      try { info = JSON.parse(e.body ?? '{}'); } catch { /* keep empty */ }
      const ids = info.commit_ids ?? [];
      return `${e.created_at} ${who}: ${info.is_force_push ? `force-pushed ${ids.map(short).join(' → ')}` : `pushed ${ids.length} commit(s)`}`;
    }
    default: return undefined;
  }
}

export function prDetails(args: CwdArg & { pr?: number; diff?: boolean }, d: ToolDeps = defaultToolDeps): Promise<ToolResult> {
  return tool(async () => {
    const s = await session(args, d);
    const pr = await findPr(s, args.pr);
    const g = s.gitea, o = s.owner, r = s.repo.name, n = pr.number;
    const [approval, commits, files, reviews, inline, comments, timeline] = await Promise.all([
      approvalFor(s, pr),
      g.pullCommits(o, r, n),
      g.pullFiles(o, r, n),
      g.listReviews(o, r, n),
      g.allReviewComments(o, r, n),
      g.listComments(o, r, n),
      g.timeline(o, r, n).catch(() => []),
    ]);
    const link = pr.state === 'open' ? undefined : promotedLink(comments);
    const out = [
      `PR #${n} "${pr.title}" ${pr.html_url}`,
      `Author: ${pr.user?.login ?? '?'} · State: ${link ? `promoted (${link})` : describeState(approval)}`,
      `Head: ${pr.head.ref} (${short(pr.head.sha)}) → Base: ${pr.base.ref}${pr.base.sha ? ` (${short(pr.base.sha)})` : ''}`,
      '', '## Description', pr.body?.trim() || '(empty)',
      '', `## Commits (${commits.length})`, ...commits.map((c) => `- ${short(c.sha)} ${c.commit.message.split('\n')[0]}`),
      '', `## Files (${files.length}, +${pr.additions ?? '?'}/−${pr.deletions ?? '?'})`,
      ...files.map((f) => `- ${f.status} ${f.previous_filename ? `${f.previous_filename} → ` : ''}${f.filename} (+${f.additions}/−${f.deletions})`),
      '', `## Reviews (${reviews.length})`,
      ...reviews.map((v) => {
        const counts = v.user?.login === s.approver && (v.state === 'APPROVED' || v.state === 'REQUEST_CHANGES');
        const flags = [v.dismissed ? 'dismissed' : '', v.commit_id && v.commit_id !== pr.head.sha ? 'older commit' : ''].filter(Boolean).join(', ');
        return `- ${v.submitted_at} ${v.user?.login ?? '?'}: ${v.state} at ${short(v.commit_id)}${flags ? ` (${flags})` : ''}${counts ? '' : ' (does not count for promotion)'}${v.body?.trim() ? `\n${indent(v.body)}` : ''}`;
      }),
      '', `## Inline comments (${inline.length})`,
      ...inline.map(({ comment: c }) => `- [${c.resolver ? 'resolved' : 'unresolved'}] comment_id ${c.id} · ${c.path}:${c.position || c.original_position} · ${c.user.login}\n${indent(c.body)}`),
      '', `## Conversation (${comments.length})`,
      ...comments.map((c) => `- ${c.created_at} ${c.user.login}\n${indent(c.body)}`),
      '', '## Timeline',
      ...(timeline.map(timelineLine).filter(Boolean) as string[]).map((l) => `- ${l}`),
    ];
    if (args.diff) {
      const diff = await g.pullDiff(o, r, n);
      out.push('', '## Diff', diff.length > DIFF_LIMIT ? `${diff.slice(0, DIFF_LIMIT)}\n… diff cut at ${DIFF_LIMIT} of ${diff.length} characters; read the rest with git locally.` : diff);
    }
    return out.join('\n');
  });
}

export function reviewComments(args: CwdArg & { pr?: number }, d: ToolDeps = defaultToolDeps): Promise<ToolResult> {
  return tool(async () => {
    const s = await session(args, d);
    const pr = await findPr(s, args.pr);
    const comments = await s.gitea.unresolvedComments(s.owner, s.repo.name, pr.number, s.claude.username);
    if (comments.length === 0) return `PR #${pr.number}: no unresolved review comments.`;
    const blocks = comments.map((c) =>
      c.id === 0
        ? `--- review summary by ${c.author} (no reply needed) ---\n${c.body}`
        : `--- comment_id: ${c.id} · ${c.path}:${c.line} · by ${c.author} ---\n${c.body}${c.diffHunk ? `\ncontext:\n${c.diffHunk}` : ''}`,
    );
    return `PR #${pr.number} "${pr.title}": ${comments.length} item(s) to address.\n\n${blocks.join('\n\n')}`;
  });
}

export function reply(args: CwdArg & { pr?: number; comment_id: number; body: string }, d: ToolDeps = defaultToolDeps): Promise<ToolResult> {
  return tool(async () => {
    const s = await session(args, d);
    const pr = await findPr(s, args.pr);
    const r = await s.gitea.replyToComment(s.owner, s.repo.name, pr.number, args.comment_id, args.body);
    return `Replied in thread ${args.comment_id}: ${r.html_url ?? ''}`.trim();
  });
}

export interface PromoteArgs extends CwdArg {
  pr?: number;
  draft?: boolean;
  base?: string;
  test_cmd?: string;
}

const NEXT_STEP: Record<number, string> = {
  [EXIT.NOT_APPROVED]: 'Not promoted: the user has not approved this PR at its current commit. Ask them to review and approve it in Gitea.',
  [EXIT.CONFLICT]: 'Not promoted: the branch is behind the current base on GitHub, and Slipway promotes exactly what was reviewed. `git fetch origin`, `git rebase origin/<base>`, resolve every conflict together with the user (show each conflict and ask when the right resolution is not obvious), run the tests, push with slipway_push force_with_lease=true, then ask the user to approve the PR again in Gitea.',
  [EXIT.SECRETS]: 'Not promoted: the secret scan blocked it (or could not run). Remove the secret from the branch history, push again and ask for a re-approval. Do not try to bypass the scan.',
  [EXIT.TESTS]: 'Not promoted: the tests failed on the rebased branch. Fix them, push and ask for a re-approval.',
  [EXIT.ERROR]: 'Not promoted.',
};

export function promoteTool(args: PromoteArgs, d: ToolDeps = defaultToolDeps): Promise<ToolResult> {
  return tool(async () => {
    const s = await session(args, d);
    const pr = await findPr(s, args.pr);
    const token = await d.githubToken();
    const r = await d.promote(
      { repo: s.repo.name, pr: pr.number, draft: !!args.draft, base: args.base, testCmd: args.test_cmd, force: false },
      { config: s.config, actor: s.claude, token },
    );
    if (r.code === EXIT.OK) return `Promoted PR #${pr.number} to GitHub: ${r.url}\nThe Slipway PR is closed with a link.`;
    const details = (r.message ?? 'see the PR comments in Gitea').replace(/\s*(or use|Use) --force\.?/gi, '.');
    throw new Error(`${NEXT_STEP[r.code] ?? 'Not promoted.'}\nDetails: ${details}`);
  });
}

export function startTask(args: CwdArg & { task_id: string; slug: string; branch?: string }, d: ToolDeps = defaultToolDeps): Promise<ToolResult> {
  return tool(async () => {
    const s = await session(args, d);
    const warning = await syncSlipwayBase(s, d);
    const r = await startTaskWorktree({ repoDir: s.repo.entry.path, base: s.repo.entry.base, taskId: args.task_id, slug: args.slug, branch: args.branch });
    return [
      `${r.existed ? 'Reusing' : 'Created'} worktree ${r.path} on branch ${r.branch} (from origin/${s.repo.entry.base}).`,
      `Work only inside it: run \`cd ${r.path}\` first, and pass cwd="${r.path}" to every slipway_* tool.`,
    ].join('\n') + warning;
  });
}
