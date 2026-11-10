import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide, ghPrSelector, pushedBranches, restPublishes, type BranchState, type HookEnv } from '../../src/mcp/hook.ts';

/** Slipway PR state per branch; `current` is the session's branch. GitHub PR #N has head `gh-N` unless mapped. */
function env(states: Record<string, BranchState>, opts: { current?: string | null; registered?: boolean; giteaDown?: boolean; ghHeads?: Record<string, string> } = {}): HookEnv {
  return {
    isRegistered: () => opts.registered ?? true,
    currentBranch: () => (opts.current === undefined ? 'agent/1-x' : opts.current),
    async branchState(b) {
      if (opts.giteaDown) throw new Error('ECONNREFUSED');
      return states[b] ?? 'none';
    },
    async githubPrHead(ref) { return opts.ghHeads?.[ref] ?? null; },
  };
}
const bash = (command: string, cwd = '/repo') => ({ tool_name: 'Bash', tool_input: { command }, cwd });

describe('PreToolUse hook: branches without a Slipway PR, or with an open one, are blocked', () => {
  it.each([
    'git push origin main',
    'git push',
    'git push -u origin agent/1-x',
    'cd sub && git push origin HEAD',
    'npm test; git push review HEAD',
    'git status && gh pr create --title x --body y',
    'gh pr merge 12 --squash',
    'gh pr ready 3',
    'gh api repos/k/d/pulls -X POST -f title=x',
    'gh api repos/k/d/pulls -f title=x -f head=agent/1-x -f base=main',
    'gh api -X PUT repos/k/d/pulls/1/merge',
    'gh api repos/k/d/git/refs -f ref=refs/heads/x -f sha=abc',
    'gh api -X PUT repos/k/d/contents/README.md -f message=x -f content=eA==',
    'cat ~/.slipway/config.json',
    'cat ~/.slipway/gitea/app.ini',
    'jq . ~/.slipway/gitea/secrets.json',
    'GIT_TRACE=1 git push origin x',
    'bin/slipway promote my-app 3 --force',
    'slipway promote my-app 3',
    '~/Projects/Slipway/scripts/promote.sh my-app 3',
    'git push --all origin',
    'git push --tags',
  ])('no Slipway PR → blocks: %s', async (cmd) => {
    const d = await decide(bash(cmd), env({}));
    expect(d.block).toBe(true);
    if (d.block) expect(d.reason).toMatch(/Slipway|slipway_/);
  });

  it.each([
    'git push origin agent/1-x',
    'git push',
    'git push --force-with-lease origin HEAD',
    'gh pr create --title y --body z',
    'gh api repos/k/d/merges -f base=main -f head=agent/1-x',
  ])('open Slipway PR → blocks: %s', async (cmd) => {
    const d = await decide(bash(cmd), env({ 'agent/1-x': 'open' }));
    expect(d.block).toBe(true);
    if (d.block) expect(d.reason).toMatch(/open Slipway PR/);
  });

  it('a branch with an open PR stays blocked even if an older PR for it was closed', async () => {
    expect((await decide(bash('git push'), env({ 'agent/1-x': 'open' }))).block).toBe(true);
  });

  it('fails closed when Slipway cannot be asked', async () => {
    const d = await decide(bash('git push origin agent/1-x'), env({ 'agent/1-x': 'closed' }, { giteaDown: true }));
    expect(d.block).toBe(true);
    if (d.block) expect(d.reason).toMatch(/slipway up/);
  });

  it('blocks a push from a detached HEAD without an explicit branch', async () => {
    expect((await decide(bash('git push origin HEAD'), env({}, { current: null }))).block).toBe(true);
  });

  it('blocks when any of several pushed branches is not cleared', async () => {
    expect((await decide(bash('git push origin done-branch agent/2-y'), env({ 'done-branch': 'closed', 'agent/2-y': 'open' }))).block).toBe(true);
  });
});

describe('PreToolUse hook: branches whose Slipway PR is closed (promoted) live on GitHub', () => {
  const promoted = env({ 'agent/1-x': 'closed' });
  it.each([
    'git push',
    'git push origin agent/1-x',
    'git push -u origin HEAD',
    'git push --force-with-lease origin agent/1-x',
    'git push origin +HEAD:refs/heads/agent/1-x',
    'gh pr comment -b "fixed"',
    'gh pr edit --add-label ready',
    'gh pr ready',
    'gh api repos/k/d/pulls/7/comments/9/replies -f body=done',
    'npm test && git push',
  ])('allows: %s', async (cmd) => {
    expect((await decide(bash(cmd), promoted)).block).toBe(false);
  });

  it('resolves a GitHub PR number to its head branch', async () => {
    const e = env({ 'agent/1-x': 'closed', 'agent/2-y': 'open' }, { ghHeads: { '7': 'agent/1-x', '8': 'agent/2-y' } });
    expect((await decide(bash('gh pr merge 7 --squash'), e)).block).toBe(false);
    expect((await decide(bash('gh pr merge 8 --squash'), e)).block).toBe(true);
    expect((await decide(bash('gh pr merge 9 --squash'), e)).block).toBe(true); // head unknown → blocked
  });

  it('still blocks shell promotion and credential reads', async () => {
    expect((await decide(bash('slipway promote my-app 3'), promoted)).block).toBe(true);
    expect((await decide(bash('cat ~/.slipway/config.json'), promoted)).block).toBe(true);
  });

  it('judges each branch: pushing a promoted branch does not clear an unreviewed one', async () => {
    const e = env({ 'agent/1-x': 'closed' }, { current: 'agent/1-x' });
    expect((await decide(bash('git push origin agent/3-new'), e)).block).toBe(true);
    expect((await decide(bash('gh pr create --head agent/3-new --title t --body b'), e)).block).toBe(true);
  });
});

describe('PreToolUse hook: read-only commands and other contexts', () => {
  it.each([
    'git status',
    'git commit --fixup=abc123',
    'gh pr view 3',
    'gh pr list',
    'gh api repos/k/d/pulls',
    'echo "remember to git push later"',
    'git log --oneline | head',
    'npm run push-docs',
  ])('allows: %s', async (cmd) => {
    expect((await decide(bash(cmd), env({}))).block).toBe(false);
  });

  it('does nothing outside Slipway repos or for other tools', async () => {
    expect((await decide(bash('git push origin main'), env({}, { registered: false }))).block).toBe(false);
    expect((await decide({ tool_name: 'Read', tool_input: {}, cwd: '/repo' }, env({}))).block).toBe(false);
  });
});

describe('argument parsing', () => {
  it('pushedBranches', () => {
    expect(pushedBranches([])).toEqual([null]);
    expect(pushedBranches(['origin'])).toEqual([null]);
    expect(pushedBranches(['-u', 'origin', 'HEAD'])).toEqual([null]);
    expect(pushedBranches(['origin', 'a', 'b:c', '+d'])).toEqual(['a', 'c', 'd']);
    expect(pushedBranches(['-o', 'ci.skip', 'origin', 'refs/heads/x'])).toEqual(['x']);
    expect(pushedBranches(['--mirror'])).toBe('all');
    expect(pushedBranches(['origin', 'refs/heads/*:refs/heads/*'])).toBe('all');
  });
  it('ghPrSelector', () => {
    expect(ghPrSelector(['-b', 'hi'])).toBeNull();
    expect(ghPrSelector(['12', '--squash'])).toBe('12');
    expect(ghPrSelector(['--body', 'x y', 'my-branch'])).toBe('my-branch');
  });
});

describe('PreToolUse hook: gh api graphql is judged by its document, not by POST', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slipway-hook-'));
  const read = '{"query":"query($o:String!){repository(owner:$o,name:\\"d\\"){pullRequest(number:70){reviewThreads(first:100){nodes{isResolved isOutdated}}}}}"}';
  writeFileSync(join(dir, 'q.json'), read);
  writeFileSync(join(dir, 'q.graphql'), 'query { viewer { login } }');
  writeFileSync(join(dir, 'm.json'), '{"query":"mutation { mergePullRequest(input:{pullRequestId:\\"x\\"}) { clientMutationId } }"}');
  writeFileSync(join(dir, 'm.graphql'), 'mutation { createPullRequest(input:{}) { clientMutationId } }');

  it.each([
    `gh api graphql --paginate -f query='query($endCursor:String){repository(owner:"k",name:"d"){pullRequest(number:70){reviewThreads(first:100,after:$endCursor){nodes{isResolved isOutdated}}}}}'`,
    `gh api graphql -f query='{ viewer { login } }' -F n=70`,
    'gh api graphql --input q.json',
    'gh api graphql --input=q.json --jq .data',
    'gh api graphql -F query=@q.graphql',
    `gh api graphql --input - <<'EOF'\n${read}\nEOF`,
  ])('read-only query → allowed without a Slipway PR: %s', async (cmd) => {
    expect((await decide(bash(cmd, dir), env({}))).block).toBe(false);
  });

  it.each([
    `gh api graphql -f query='mutation { createCommitOnBranch(input:{}) { commit { oid } } }'`,
    `gh api graphql -f query='mutation { a: resolveReviewThread(input:{threadId:"x"}) { thread { id } } b: mergePullRequest(input:{pullRequestId:"y"}) { clientMutationId } }'`,
    'gh api graphql --input m.json',
    'gh api graphql -F query=@m.graphql',
    'gh api graphql --input missing.json',
    `gh api graphql --input - <<'EOF'\n{"query":"mutation { x }"}\nEOF`,
  ])('publishing mutation (or an unreadable or unparseable document) → blocked without a Slipway PR: %s', async (cmd) => {
    const d = await decide(bash(cmd, dir), env({}));
    expect(d.block).toBe(true);
    if (d.block) expect(d.reason).toMatch(/gh api/);
  });

  it('a mutation is allowed on a promoted branch', async () => {
    expect((await decide(bash('gh api graphql --input m.json', dir), env({ 'agent/1-x': 'closed' }))).block).toBe(false);
  });
});

describe('PreToolUse hook: only publishing code or a PR is guarded, discussion and other writes pass', () => {
  // Session on a branch without a Slipway PR, e.g. reviewing a colleague's PR #70.
  it.each([
    'gh pr review 70 --request-changes -b "see the nits"',
    'gh pr comment 70 -b thanks',
    'gh pr edit 70 --add-label needs-work',
    'gh pr close 70',
    'gh api repos/o/r/pulls/70/reviews --input review.json',
    'gh api -X POST repos/o/r/pulls/70/comments/123/replies -f body=done',
    "gh api 'repos/{owner}/{repo}/pulls/70/comments' -f body=x -f path=a.ts -F line=64",
    'gh api repos/o/r/issues/70/comments -f body=x',
    'gh api --method PATCH repos/o/r/pulls/70 -f title=x',
    'gh api repos/other/repo/issues -f title=bug',
    'gh api repos/o/r/labels -f name=bug',
    'gh api gists -f description=x',
    "gh api -X GET search/issues -f q='repo:o/r is:open'",
    'gh api --method GET repos/o/r/pulls -f state=closed',
    'gh api -XGET repos/o/r/pulls -f state=closed',
    `gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=PRRT_x`,
    `gh api graphql -f query='mutation{a:resolveReviewThread(input:{threadId:"1"}){thread{id}} b:addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:"2",body:"ok"}){comment{id}}}'`,
    `gh api graphql -f query='mutation{addPullRequestReview(input:{pullRequestId:"PR_x",event:REQUEST_CHANGES,body:"x"}){pullRequestReview{id}}}'`,
  ])('allowed: %s', async (cmd) => {
    expect((await decide(bash(cmd), env({}, { current: 'docs/hc-4' }))).block).toBe(false);
  });

  it('restPublishes', () => {
    expect(restPublishes('repos/o/r/pulls', 'POST')).toBe(true);
    expect(restPublishes('/repos/o/r/pulls/', 'POST')).toBe(true);
    expect(restPublishes('repos/o/r/pulls', 'GET')).toBe(false);
    expect(restPublishes('repos/o/r/pulls/7/merge', 'PUT')).toBe(true);
    expect(restPublishes('repos/o/r/pulls/7/update-branch', 'PUT')).toBe(true);
    expect(restPublishes('repos/o/r/git/refs/heads/x', 'PATCH')).toBe(true);
    expect(restPublishes('repos/o/r/contents/a/b.md', 'PUT')).toBe(true);
    expect(restPublishes('repos/o/r/merges', 'POST')).toBe(true);
    expect(restPublishes('repos/o/r/pulls/7', 'PATCH')).toBe(false);
    expect(restPublishes('repos/o/r/pulls/7/reviews', 'POST')).toBe(false);
    expect(restPublishes('repos/o/r/issues/7/comments', 'POST')).toBe(false);
    expect(restPublishes('repos/o/r/git/refs', 'GET')).toBe(false);
  });
});
