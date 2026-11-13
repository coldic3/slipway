import { describe, expect, it, vi } from 'vitest';
import type { SlipwayConfig } from '../../src/config.ts';
import { GiteaError } from '../../src/gitea/client.ts';
import { resetEnrollmentCache } from '../../src/mcp/enroll.ts';
import { closePr, defaultToolDeps, listPrs, openPr, prDetails, promoteTool, push, reply, resetIdentityCheck, reviewComments, status, updatePr, type ToolDeps } from '../../src/mcp/tools.ts';

const config = (): SlipwayConfig => ({
  giteaUrl: 'http://g', admin: { username: 'admin', password: 'a', token: 'at' }, reviewer: { username: 'slipway', password: 'p', token: 'ot' }, org: 'repos',
  claude: { username: 'claude-mac', password: 'x', token: 'ct' },
  repos: { demo: { path: '/repo', base: 'main', github: 'kevin/demo' } },
});

const pull = { number: 7, title: 'Add x', body: 'b', state: 'open', html_url: 'http://g/slipway/demo/pulls/7', head: { ref: 'agent/7-x', sha: 'h1' }, base: { ref: 'main' } };

function deps(over: { reviews?: any[]; pulls?: any[]; token?: () => Promise<string>; promoteResult?: any; syncFails?: boolean; timeline?: any[]; branches?: string[]; pr?: any; comments?: any[] } = {}) {
  const calls: string[] = [];
  const gitea = {
    version: vi.fn(async () => ({ version: '28.3.0' })),
    listPulls: vi.fn(async () => over.pulls ?? [pull]),
    getPull: vi.fn(async () => over.pr ?? pull),
    timeline: vi.fn(async () => over.timeline ?? []),
    branchExists: vi.fn(async (_o: string, _r: string, b: string) => (over.branches ?? ['main', 'agent/6-parent']).includes(b)),
    pullCommits: vi.fn(async () => [{ sha: 'c1aaaaaaaa', commit: { message: 'feat: x\n\nbody' } }]),
    pullFiles: vi.fn(async () => [{ filename: 'src/x.ts', status: 'added', additions: 3, deletions: 0 }]),
    listComments: vi.fn(async () => over.comments ?? []),
    comment: vi.fn(async () => ({ id: 1 })),
    allReviewComments: vi.fn(async () => []),
    pullDiff: vi.fn(async () => 'diff --git a/x b/x\n' + 'x'.repeat(200_000)),
    listReviews: vi.fn(async () => over.reviews ?? []),
    editPull: vi.fn(async () => pull),
    unresolvedComments: vi.fn(async () => [
      { id: 0, path: '', line: 0, body: 'Please add tests', author: 'slipway', diffHunk: '' },
      { id: 41, path: 'src/a.ts', line: 3, body: 'rename this', author: 'slipway', diffHunk: '@@ -1 +1 @@\n+const a = 1' },
    ]),
    replyToComment: vi.fn(async () => ({ id: 99, html_url: 'http://g/c/99' })),
    createPull: vi.fn(async () => ({ number: 8, html_url: 'http://g/repos/demo/pulls/8' })),
    req: vi.fn(async () => ({ login: 'claude-mac' })),
  };
  const d: ToolDeps = {
    loadConfig: config,
    saveConfig: () => {},
    hostname: () => 'mac',
    gitea: () => gitea as any,
    admin: () => { throw new Error('no enrollment expected'); },
    githubToken: over.token ?? (async () => 'gh-token'),
    syncBase: vi.fn(async () => { calls.push('sync'); if (over.syncFails) throw new Error('could not fetch main from GitHub (origin): offline'); }),
    pushBranch: vi.fn(async () => { calls.push('push'); return { ok: true, message: 'Pushed agent/7-x (abc12345) to Slipway.' }; }),
    promote: vi.fn(async () => over.promoteResult ?? { code: 0, url: 'https://github.com/kevin/demo/pull/5' }),
    resolveRepo: async () => ({ name: 'demo', entry: config().repos.demo!, worktree: '/repo', branch: 'agent/7-x' }),
  } as unknown as ToolDeps;
  return { d, gitea, calls };
}

describe('MCP tools', () => {
  it('status reports repo, Claude user, branch and PR state', async () => {
    const { d } = deps({ reviews: [{ user: { login: 'slipway' }, state: 'REQUEST_CHANGES', commit_id: 'h1', dismissed: false }] });
    const r = await status({}, d);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/demo/);
    expect(r.text).toMatch(/claude-mac/);
    expect(r.text).toMatch(/agent\/7-x/);
    expect(r.text).toMatch(/#7/);
    expect(r.text).toMatch(/changes-requested/);
    expect(r.text).not.toMatch(/ct|ot\b/);
  });

  it('update_pr is refused once the PR is approved at its head (Review Focus 2)', async () => {
    const { d, gitea } = deps({ reviews: [{ user: { login: 'slipway' }, state: 'APPROVED', commit_id: 'h1', dismissed: false }] });
    const r = await updatePr({ title: 'Sneaky' }, d);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/approved/i);
    expect(gitea.editPull).not.toHaveBeenCalled();
  });

  it('update_pr edits title/body before approval', async () => {
    const { d, gitea } = deps();
    expect((await updatePr({ title: 'feat: add x', body: 'new' }, d)).isError).toBeFalsy();
    expect(gitea.editPull).toHaveBeenCalledWith('repos', 'demo', 7, { title: 'feat: add x', body: 'new' });
  });

  it('review_comments lists ids, locations, bodies and hunks for the current branch PR', async () => {
    const { d, gitea } = deps();
    const r = await reviewComments({}, d);
    expect(gitea.unresolvedComments).toHaveBeenCalledWith('repos', 'demo', 7, 'claude-mac');
    expect(r.text).toMatch(/Please add tests/);
    expect(r.text).toMatch(/comment_id: 41/);
    expect(r.text).toMatch(/src\/a\.ts:3/);
    expect(r.text).toMatch(/const a = 1/);
  });

  it('reply posts in the thread', async () => {
    const { d, gitea } = deps();
    await reply({ comment_id: 41, body: 'Renamed.' }, d);
    expect(gitea.replyToComment).toHaveBeenCalledWith('repos', 'demo', 7, 41, 'Renamed.');
  });

  it('no PR for the branch → helpful error listing open PRs', async () => {
    const { d } = deps({ pulls: [{ ...pull, number: 3, head: { ref: 'agent/3-other', sha: 'z' } }] });
    const r = await reviewComments({}, d);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/#3/);
  });

  it('promote: gh missing or logged out → readable error, promotion not attempted (Review Focus 3)', async () => {
    const { d } = deps({ token: async () => { throw new Error('The GitHub CLI is not logged in. Run: gh auth login'); } });
    const r = await promoteTool({}, d);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/gh auth login/);
    expect((d as any).promote).not.toHaveBeenCalled();
  });

  it('promote: success returns the GitHub URL; acts as the Claude user with the gh token', async () => {
    const { d } = deps();
    const r = await promoteTool({ draft: true }, d);
    expect(r.text).toContain('https://github.com/kevin/demo/pull/5');
    expect((d as any).promote).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'demo', pr: 7, draft: true, force: false }),
      expect.objectContaining({ actor: expect.objectContaining({ username: 'claude-mac' }), token: 'gh-token' }),
    );
  });

  it('promote: blocked outcomes explain what to do next', async () => {
    for (const [code, re] of [[5, /approve/i], [2, /behind[\s\S]*rebase[\s\S]*force_with_lease[\s\S]*approv/i], [3, /secret/i], [4, /tests/i]] as const) {
      const { d } = deps({ promoteResult: { code, message: 'why' } });
      const r = await promoteTool({}, d);
      expect(r.isError, String(code)).toBe(true);
      expect(r.text).toMatch(re);
    }
  });

  it('promote errors never suggest --force (I-4)', async () => {
    const { d } = deps({ promoteResult: { code: 5, message: 'PR #7 is not approved by slipway at its current head. Approve it in Gitea or use --force.' } });
    const r = await promoteTool({}, d);
    expect(r.text).not.toMatch(/--force/);
  });

  it('a saved Claude token that Gitea rejects (instance was reset) re-enrolls instead of failing forever (I-2)', async () => {
    resetIdentityCheck();
    resetEnrollmentCache();
    const { d, gitea } = deps();
    let cfg = config();
    const saved: SlipwayConfig[] = [];
    (d as any).loadConfig = () => cfg;
    (d as any).saveConfig = (c: SlipwayConfig) => { saved.push(structuredClone(c)); cfg = c; };
    gitea.req.mockRejectedValueOnce(new GiteaError(401, 'GET', '/user', 'unauthorized'));
    const admin = { createUser: vi.fn(async () => {}), resetPassword: vi.fn(async () => {}), createToken: vi.fn(async () => 'fresh-token'), addCollaborator: vi.fn(async () => {}) };
    (d as any).admin = () => admin;
    const r = await status({}, d);
    expect(r.isError, r.text).toBeFalsy();
    expect(admin.createUser).toHaveBeenCalled();
    expect(saved.at(-1)!.claude!.token).toBe('fresh-token');
  });

  it('push and open_pr first sync Slipway main with GitHub (so the PR diff is against the current main)', async () => {
    const { d, calls } = deps({ pulls: [] });
    expect((await push({}, d)).isError).toBeFalsy();
    expect(calls).toEqual(['sync', 'push']);
    calls.length = 0;
    expect((await openPr({ title: 't', body: 'b' }, d)).text).toMatch(/Opened PR #8/);
    expect(calls).toEqual(['sync', 'push']);
  });

  it('a failed sync (e.g. offline) does not block pushing; the result carries a warning', async () => {
    const { d, calls } = deps({ syncFails: true });
    const r = await push({}, d);
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual(['sync', 'push']);
    expect(r.text).toMatch(/Warning: Slipway main was not updated from GitHub.*offline/);
  });

  const approvedAt = (t: string) => [{ user: { login: 'slipway' }, state: 'APPROVED', commit_id: 'h1', dismissed: false, submitted_at: t }];

  it('update_pr retargets the PR and says how big the diff is now', async () => {
    const { d, gitea } = deps();
    gitea.getPull.mockResolvedValueOnce({ ...pull, base: { ref: 'agent/6-parent' }, changed_files: 4, additions: 10, deletions: 2 });
    const r = await updatePr({ base: 'agent/6-parent' }, d);
    expect(r.isError, r.text).toBeFalsy();
    expect(gitea.editPull).toHaveBeenCalledWith('repos', 'demo', 7, { base: 'agent/6-parent' });
    expect(r.text).toMatch(/main → agent\/6-parent/);
    expect(r.text).toMatch(/1 commit\(s\), 4 file\(s\) \(\+10\/−2\)/);
    expect(r.text).not.toMatch(/approve/i);
  });

  it('update_pr may retarget an approved PR and says the approval no longer counts', async () => {
    const { d, gitea } = deps({ reviews: approvedAt('2026-11-12T10:00:00Z') });
    const r = await updatePr({ base: 'agent/6-parent' }, d);
    expect(r.isError, r.text).toBeFalsy();
    expect(gitea.editPull).toHaveBeenCalled();
    expect(r.text).toMatch(/approval no longer counts/);
  });

  it('update_pr on an approved PR refuses the whole call when it also sets the title', async () => {
    const { d, gitea } = deps({ reviews: approvedAt('2026-11-12T10:00:00Z') });
    const r = await updatePr({ base: 'agent/6-parent', title: 'x' }, d);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/nothing was changed[\s\S]*base alone/);
    expect(gitea.editPull).not.toHaveBeenCalled();
  });

  it('update_pr refuses a base that is the head itself or missing in Slipway', async () => {
    const { d, gitea } = deps();
    expect((await updatePr({ base: 'agent/7-x' }, d)).text).toMatch(/own branch/);
    expect((await updatePr({ base: 'feat/nope' }, d)).text).toMatch(/does not exist in Slipway/);
    expect(gitea.editPull).not.toHaveBeenCalled();
  });

  it('update_pr refuses closed PRs', async () => {
    const { d } = deps({ pr: { ...pull, state: 'closed' } });
    expect((await updatePr({ pr: 7, base: 'agent/6-parent' }, d)).text).toMatch(/is closed/);
  });

  it('an approval from before the last base change does not count (status shows why)', async () => {
    const { d } = deps({ reviews: approvedAt('2026-11-12T10:00:00Z'), timeline: [{ type: 'change_target_branch', created_at: '2026-11-12T11:00:00Z', old_ref: 'main', new_ref: 'agent/6-parent' }] });
    const r = await status({}, d);
    expect(r.text).toMatch(/State: in-review \(approved before the base changed/);
    expect((await updatePr({ title: 'now allowed' }, d)).isError).toBeFalsy();
  });

  it('open_pr validates the base', async () => {
    const { d, gitea } = deps({ pulls: [] });
    expect((await openPr({ title: 't', body: 'b', base: 'feat/nope' }, d)).text).toMatch(/does not exist/);
    expect((await openPr({ title: 't', body: 'b', base: 'agent/6-parent' }, d)).isError).toBeFalsy();
    expect(gitea.createPull).toHaveBeenCalledWith('repos', 'demo', expect.objectContaining({ base: 'agent/6-parent' }));
  });

  it('close_pr posts the reason, then closes; a closed PR is a no-op', async () => {
    const { d, gitea } = deps();
    const r = await closePr({ pr: 7, reason: 'Superseded by #8 and #9' }, d);
    expect(r.isError, r.text).toBeFalsy();
    expect(gitea.comment).toHaveBeenCalledWith('repos', 'demo', 7, 'Closed by claude-mac: Superseded by #8 and #9');
    expect(gitea.editPull).toHaveBeenCalledWith('repos', 'demo', 7, { state: 'closed' });
    expect(gitea.comment.mock.invocationCallOrder[0]!).toBeLessThan(gitea.editPull.mock.invocationCallOrder[0]!);
    const closed = deps({ pr: { ...pull, state: 'closed' } });
    expect((await closePr({ pr: 7, reason: 'x' }, closed.d)).text).toMatch(/already closed/);
    expect(closed.gitea.editPull).not.toHaveBeenCalled();
    expect((await closePr({ pr: 7, reason: '  ' }, d)).isError).toBe(true);
  });

  it('list_prs shows head → base, state and unresolved count; closed PRs show promotion', async () => {
    const { d } = deps({ pulls: [pull, { ...pull, number: 8, title: 'Child', head: { ref: 'agent/8-y', sha: 'h8' }, base: { ref: 'agent/7-x' } }] });
    const r = await listPrs({}, d);
    expect(r.text).toMatch(/#7 Add x · agent\/7-x → main · in-review · unresolved: 2 · \(this branch\)/);
    expect(r.text).toMatch(/#8 Child · agent\/8-y → agent\/7-x · in-review/);
    const closed = deps({ pulls: [{ ...pull, state: 'closed' }], comments: [{ id: 1, body: '🚢 Promoted to GitHub: https://github.com/kevin/demo/pull/5', user: { login: 'claude-mac' }, created_at: 't' }] });
    expect((await listPrs({ state: 'closed' }, closed.d)).text).toMatch(/promoted \(https:\/\/github.com\/kevin\/demo\/pull\/5\)/);
  });

  it('pr shows base/head, description, commits, files, reviews, comments and timeline; the diff is cut', async () => {
    const { d } = deps({
      reviews: approvedAt('2026-11-12T10:00:00Z'),
      comments: [{ id: 1, body: 'Closed by x: y', user: { login: 'claude-mac' }, created_at: '2026-11-12T09:00:00Z' }],
      timeline: [
        { type: 'change_target_branch', created_at: '2026-11-12T11:00:00Z', user: { login: 'claude-mac' }, old_ref: 'main', new_ref: 'agent/6-parent' },
        { type: 'pull_push', created_at: '2026-11-12T11:01:00Z', user: { login: 'claude-mac' }, body: '{"is_force_push":true,"commit_ids":["aaaaaaaaaa","bbbbbbbbbb"]}' },
      ],
    });
    const r = await prDetails({ diff: true }, d);
    expect(r.isError, r.text).toBeFalsy();
    for (const re of [/Head: agent\/7-x \(h1\) → Base: main/, /## Description\nb/, /c1aaaaaa feat: x$/m, /added src\/x\.ts \(\+3\/−0\)/,
      /slipway: APPROVED at h1/, /Closed by x: y/, /base main → agent\/6-parent/, /force-pushed aaaaaaaa → bbbbbbbb/,
      /approved before the base changed/, /diff cut at 100000/]) expect(r.text).toMatch(re);
  });

  it('in a Docker sandbox: status shows the browser URL, an unreachable host Gitea says what to run on the host', async () => {
    const sandboxed = (): SlipwayConfig => ({ ...config(), giteaUrl: 'http://host.docker.internal:3030', webUrl: 'http://127.0.0.1:3030', sandbox: 'sb' });
    const { d } = deps();
    const ok = await status({}, { ...d, loadConfig: sandboxed, ensureGitea: async () => {} });
    expect(ok.text).toMatch(/Gitea: http:\/\/127\.0\.0\.1:3030/);
    // Port 9 (discard) refuses at once: the check is deterministic, without the host's own Slipway.
    const down = await status({}, { ...d, loadConfig: () => ({ ...sandboxed(), giteaUrl: 'http://127.0.0.1:9' }), ensureGitea: defaultToolDeps.ensureGitea });
    expect(down.isError).toBe(true);
    expect(down.text).toMatch(/not reachable from this sandbox .*slipway sbx setup sb/);
  });

  it('without a config inside a Docker sandbox, points to slipway sbx setup on the host', async () => {
    const { d } = deps();
    const missing = { ...d, loadConfig: () => { throw new Error('missing'); } };
    expect((await status({}, missing)).text).toMatch(/slipway init/);
    process.env.SANDBOX_NAME = 'claude-demo';
    try {
      expect((await status({}, missing)).text).toMatch(/on the host: slipway sbx setup claude-demo/);
    } finally {
      delete process.env.SANDBOX_NAME;
    }
  });
});

