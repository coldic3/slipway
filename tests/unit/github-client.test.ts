import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GitHubClient } from '../../src/github/client.ts';
import { MockGitHub } from '../helpers/mock-github.ts';

describe('GitHubClient.upsertPull', () => {
  const gh = new MockGitHub();
  let client: GitHubClient;
  beforeAll(async () => { client = new GitHubClient(await gh.start(), 'tok'); });
  afterAll(() => gh.stop());
  beforeEach(() => { gh.pulls = []; gh.requests = []; });

  const input = { repo: 'kevin/demo', head: 'agent/1-x', base: 'main', title: 'Add `x` ąę', body: '## What\n\n- `code` ąę', draft: false };

  it('creates a PR with exact title/body and bearer auth', async () => {
    const r = await client.upsertPull(input);
    expect(r).toEqual({ number: 1, html_url: 'https://github.com/kevin/demo/pull/1', updated: false });
    const post = gh.requests.find((q) => q.method === 'POST')!;
    expect(post.headers.authorization).toBe('Bearer tok');
    expect(post.body).toMatchObject({ head: 'agent/1-x', base: 'main', title: input.title, body: input.body, draft: false });
    expect(gh.requests[0]!.url).toBe('/repos/kevin/demo/pulls?head=kevin%3Aagent%2F1-x&state=open');
  });

  it('updates the existing open PR instead of creating a duplicate', async () => {
    await client.upsertPull(input);
    const r = await client.upsertPull({ ...input, title: 'New title' });
    expect(r.updated).toBe(true);
    expect(gh.pulls).toHaveLength(1);
    expect(gh.pulls[0]!.title).toBe('New title');
  });

  it('throws a readable error on API failure', async () => {
    const bad = new GitHubClient(gh.url, '');
    await expect(bad.upsertPull(input)).rejects.toThrow(/401/);
  });
});

describe('GitHubClient.mergedPullFor', () => {
  const gh = new MockGitHub();
  let client: GitHubClient;
  beforeAll(async () => { client = new GitHubClient(await gh.start(), 'tok'); });
  afterAll(() => gh.stop());

  it('finds a merged PR for the head, ignoring closed-unmerged ones', async () => {
    const mk = (number: number, head: string, merged_at: string | null) =>
      ({ number, head, base: 'main', title: 't', body: '', draft: false, state: 'closed' as const, html_url: `https://github.com/kevin/demo/pull/${number}`, merged_at });
    gh.pulls = [mk(1, 'agent/3-parent', null), mk(2, 'agent/3-parent', '2026-11-12T10:00:00Z'), mk(3, 'other', '2026-11-12T10:00:00Z')];
    expect(await client.mergedPullFor('kevin/demo', 'agent/3-parent')).toEqual({ number: 2, html_url: 'https://github.com/kevin/demo/pull/2' });
    expect(gh.requests.at(-1)!.url).toBe('/repos/kevin/demo/pulls?head=kevin%3Aagent%2F3-parent&state=closed');
    gh.pulls = [mk(1, 'agent/3-parent', null)];
    expect(await client.mergedPullFor('kevin/demo', 'agent/3-parent')).toBeNull();
  });
});
