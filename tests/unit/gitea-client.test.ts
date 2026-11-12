import { describe, expect, it } from 'vitest';
import { GiteaClient } from '../../src/gitea/client.ts';

type Route = (method: string, path: string, body: any) => unknown;

function fakeFetch(route: Route, calls: Array<{ method: string; path: string; body: any }>) {
  return (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? 'GET';
    const path = u.pathname.replace('/api/v1', '') + u.search;
    calls.push({ method, path, body });
    const data = route(method, path, body);
    return new Response(data === undefined ? '' : JSON.stringify(data), { status: data === undefined ? 204 : 200 });
  }) as typeof fetch;
}

describe('GiteaClient', () => {
  it('unresolvedComments: skips resolved threads, dismissed reviews and the agent; adds the latest change-request body', async () => {
    const calls: any[] = [];
    const gitea = new GiteaClient('http://g', 'tok', fakeFetch((m, p) => {
      if (p.startsWith('/repos/o/r/pulls/3/reviews?')) return [
        { id: 1, state: 'REQUEST_CHANGES', body: 'old summary', dismissed: false, user: { login: 'kevin' }, submitted_at: '2026-01-01' },
        { id: 2, state: 'REQUEST_CHANGES', body: 'Please add tests', dismissed: false, user: { login: 'kevin' }, submitted_at: '2026-01-02' },
        { id: 3, state: 'COMMENT', body: '', dismissed: true, user: { login: 'kevin' }, submitted_at: '2026-01-03' },
        { id: 4, state: 'COMMENT', body: '', dismissed: false, user: { login: 'agent-bot' }, submitted_at: '2026-01-04' },
      ];
      if (p.startsWith('/repos/o/r/pulls/3/reviews/1/comments')) return [
        { id: 10, path: 'a.ts', position: 3, original_position: 3, body: 'resolved one', diff_hunk: '', resolver: { login: 'kevin' }, user: { login: 'kevin' } },
      ];
      if (p.startsWith('/repos/o/r/pulls/3/reviews/2/comments')) return [
        { id: 11, path: 'b.ts', position: 5, original_position: 5, body: 'rename', diff_hunk: '@@', resolver: null, user: { login: 'kevin' } },
        { id: 12, path: 'a.ts', position: 3, original_position: 3, body: 'same line as resolved thread', diff_hunk: '', resolver: null, user: { login: 'kevin' } },
      ];
      if (p.startsWith('/repos/o/r/pulls/3/reviews/3/comments')) return [
        { id: 13, path: 'c.ts', position: 1, original_position: 1, body: 'dismissed', diff_hunk: '', resolver: null, user: { login: 'kevin' } },
      ];
      if (p.startsWith('/repos/o/r/pulls/3/reviews/4/comments')) return [
        { id: 14, path: 'b.ts', position: 5, original_position: 5, body: 'agent reply', diff_hunk: '', resolver: null, user: { login: 'agent-bot' } },
      ];
      return [];
    }, calls));
    const got = await gitea.unresolvedComments('o', 'r', 3, 'agent-bot');
    expect(got).toEqual([
      { id: 0, path: '', line: 0, body: 'Please add tests', author: 'kevin', diffHunk: '' },
      { id: 11, path: 'b.ts', line: 5, body: 'rename', author: 'kevin', diffHunk: '@@' },
    ]);
  });

  it('sends token auth and surfaces API errors with status', async () => {
    const f = (async (_u: string, init?: RequestInit) => {
      expect((init!.headers as Record<string, string>).authorization).toBe('token tok');
      return new Response('{"message":"nope"}', { status: 403 });
    }) as typeof fetch;
    await expect(new GiteaClient('http://g', 'tok', f).getPull('o', 'r', 1)).rejects.toMatchObject({ status: 403 });
  });
});

describe('GiteaClient: stacked PR helpers', () => {
  it('timeline, commits, files and base edits hit the right endpoints', async () => {
    const calls: any[] = [];
    const gitea = new GiteaClient('http://g', 'tok', fakeFetch((m, p) => {
      if (p.startsWith('/repos/o/r/issues/3/timeline')) return [{ type: 'change_target_branch', created_at: '2026-11-12T10:00:00Z', old_ref: 'a', new_ref: 'b' }];
      if (p.startsWith('/repos/o/r/pulls/3/commits')) return [{ sha: 's1', commit: { message: 'feat: x' } }];
      if (p.startsWith('/repos/o/r/pulls/3/files')) return [{ filename: 'a.ts', status: 'added', additions: 1, deletions: 0 }];
      if (m === 'PATCH') return { number: 3 };
      return [];
    }, calls));
    expect((await gitea.timeline('o', 'r', 3))[0]!.new_ref).toBe('b');
    expect((await gitea.pullCommits('o', 'r', 3))[0]!.sha).toBe('s1');
    expect((await gitea.pullFiles('o', 'r', 3))[0]!.filename).toBe('a.ts');
    await gitea.editPull('o', 'r', 3, { base: 'b' });
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', path: '/repos/o/r/pulls/3', body: { base: 'b' } });
  });

  it('branchExists: true on 200, false on 404, throws otherwise', async () => {
    const status = (s: number) => new GiteaClient('http://g', 't', (async () => new Response('{}', { status: s })) as typeof fetch);
    expect(await status(200).branchExists('o', 'r', 'feat/a')).toBe(true);
    expect(await status(404).branchExists('o', 'r', 'feat/a')).toBe(false);
    await expect(status(500).branchExists('o', 'r', 'feat/a')).rejects.toThrow(/500/);
  });
});
