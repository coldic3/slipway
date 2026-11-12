export interface UpsertPullInput {
  /** owner/name */
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface UpsertPullResult {
  number: number;
  html_url: string;
  updated: boolean;
}

/** Tiny GitHub REST client. The base URL is configurable so tests can point it at a mock. */
export class GitHubClient {
  constructor(
    private readonly apiBase: string,
    private readonly token: string,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.apiBase.replace(/\/$/, '') + path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'slipway',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Creates the PR or, if an open PR for the same head exists, updates its title/body/base. */
  async upsertPull(input: UpsertPullInput): Promise<UpsertPullResult> {
    const [owner] = input.repo.split('/');
    const q = new URLSearchParams({ head: `${owner}:${input.head}`, state: 'open' });
    const existing = await this.req<Array<{ number: number; html_url: string }>>('GET', `/repos/${input.repo}/pulls?${q}`);
    if (existing.length > 0) {
      const pr = existing[0]!;
      await this.req('PATCH', `/repos/${input.repo}/pulls/${pr.number}`, { title: input.title, body: input.body, base: input.base });
      return { number: pr.number, html_url: pr.html_url, updated: true };
    }
    const pr = await this.req<{ number: number; html_url: string }>('POST', `/repos/${input.repo}/pulls`, {
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
      draft: input.draft,
      maintainer_can_modify: true,
    });
    return { number: pr.number, html_url: pr.html_url, updated: false };
  }

  /** The merged PR whose head is `head` (same owner), if any: a stacked child must not be promoted into a merged parent. */
  async mergedPullFor(repo: string, head: string): Promise<{ number: number; html_url: string } | null> {
    const [owner] = repo.split('/');
    const q = new URLSearchParams({ head: `${owner}:${head}`, state: 'closed' });
    const closed = await this.req<Array<{ number: number; html_url: string; merged_at: string | null }>>('GET', `/repos/${repo}/pulls?${q}`);
    const merged = closed.find((p) => p.merged_at);
    return merged ? { number: merged.number, html_url: merged.html_url } : null;
  }
}
