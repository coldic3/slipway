import type { GComment, GCommit, GFile, GHook, GLabel, GPull, GRepo, GReview, GReviewComment, GTimelineEvent, UnresolvedComment } from './types.ts';

export class GiteaError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`Gitea API ${method} ${path} failed: ${status} ${body.slice(0, 500)}`);
  }
}

export type GiteaAuth = string | { basic: [string, string] };

/** Thin typed wrapper over the Gitea REST API (v1). */
export class GiteaClient {
  constructor(
    readonly baseUrl: string,
    private readonly auth: GiteaAuth,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async req<T>(method: string, path: string, body?: unknown, accept = 'application/json'): Promise<T> {
    const headers: Record<string, string> = { accept, 'content-type': 'application/json' };
    if (typeof this.auth === 'string') headers.authorization = `token ${this.auth}`;
    else headers.authorization = 'Basic ' + Buffer.from(this.auth.basic.join(':')).toString('base64');
    const res = await this.fetchImpl(this.baseUrl.replace(/\/$/, '') + '/api/v1' + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new GiteaError(res.status, method, path, text);
    if (accept !== 'application/json') return text as T;
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Fetches all pages of a list endpoint. */
  async all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page < 100; page++) {
      const items = await this.req<T[]>('GET', `${path}${sep}limit=50&page=${page}`);
      out.push(...items);
      if (items.length < 50) break;
    }
    return out;
  }

  version() { return this.req<{ version: string }>('GET', '/version'); }

  // ---- users & tokens -------------------------------------------------------
  async createToken(username: string, name: string, scopes: string[]): Promise<string> {
    try {
      await this.req('DELETE', `/users/${username}/tokens/${encodeURIComponent(name)}`);
    } catch (e) {
      if (!(e instanceof GiteaError && e.status === 404)) throw e;
    }
    const t = await this.req<{ sha1: string }>('POST', `/users/${username}/tokens`, { name, scopes });
    return t.sha1;
  }

  // ---- repos ------------------------------------------------------------------
  createRepo(name: string, description = '') {
    return this.req<GRepo>('POST', '/user/repos', { name, description, private: true, auto_init: false, default_branch: 'main' });
  }
  getRepo(owner: string, repo: string) { return this.req<GRepo>('GET', `/repos/${owner}/${repo}`); }
  editRepo(owner: string, repo: string, opts: Record<string, unknown>) { return this.req<GRepo>('PATCH', `/repos/${owner}/${repo}`, opts); }
  addCollaborator(owner: string, repo: string, user: string, permission: 'read' | 'write' | 'admin') {
    return this.req('PUT', `/repos/${owner}/${repo}/collaborators/${user}`, { permission });
  }
  listBranchProtections(owner: string, repo: string) { return this.req<Array<{ rule_name: string }>>('GET', `/repos/${owner}/${repo}/branch_protections`); }
  createBranchProtection(owner: string, repo: string, opts: Record<string, unknown>) {
    return this.req('POST', `/repos/${owner}/${repo}/branch_protections`, opts);
  }
  editBranchProtection(owner: string, repo: string, name: string, opts: Record<string, unknown>) {
    return this.req('PATCH', `/repos/${owner}/${repo}/branch_protections/${encodeURIComponent(name)}`, opts);
  }
  // ---- pulls --------------------------------------------------------------------
  getPull(owner: string, repo: string, idx: number) { return this.req<GPull>('GET', `/repos/${owner}/${repo}/pulls/${idx}`); }
  listPulls(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open') {
    return this.all<GPull>(`/repos/${owner}/${repo}/pulls?state=${state}`);
  }
  createPull(owner: string, repo: string, opts: { head: string; base: string; title: string; body: string }) {
    return this.req<GPull>('POST', `/repos/${owner}/${repo}/pulls`, opts);
  }
  editPull(owner: string, repo: string, idx: number, opts: { title?: string; body?: string; base?: string; state?: 'open' | 'closed' }) {
    return this.req<GPull>('PATCH', `/repos/${owner}/${repo}/pulls/${idx}`, opts);
  }
  closePull(owner: string, repo: string, idx: number) { return this.editPull(owner, repo, idx, { state: 'closed' }); }
  mergePull(owner: string, repo: string, idx: number, style = 'merge') {
    return this.req('POST', `/repos/${owner}/${repo}/pulls/${idx}/merge`, { Do: style });
  }
  pullDiff(owner: string, repo: string, idx: number) {
    return this.req<string>('GET', `/repos/${owner}/${repo}/pulls/${idx}.diff`, undefined, 'text/plain');
  }

  pullCommits(owner: string, repo: string, idx: number) {
    return this.all<GCommit>(`/repos/${owner}/${repo}/pulls/${idx}/commits?stat=false&files=false&verification=false`);
  }
  pullFiles(owner: string, repo: string, idx: number) { return this.all<GFile>(`/repos/${owner}/${repo}/pulls/${idx}/files`); }
  /** Issue timeline of a PR, oldest first: base changes, pushes, reviews, comments, close/reopen. */
  timeline(owner: string, repo: string, idx: number) { return this.all<GTimelineEvent>(`/repos/${owner}/${repo}/issues/${idx}/timeline`); }
  async branchExists(owner: string, repo: string, branch: string): Promise<boolean> {
    try {
      await this.req('GET', `/repos/${owner}/${repo}/branches/${branch.split('/').map(encodeURIComponent).join('/')}`);
      return true;
    } catch (e) {
      if (e instanceof GiteaError && e.status === 404) return false;
      throw e;
    }
  }

  listReviews(owner: string, repo: string, idx: number) { return this.all<GReview>(`/repos/${owner}/${repo}/pulls/${idx}/reviews`); }
  listReviewComments(owner: string, repo: string, idx: number, reviewId: number) {
    return this.req<GReviewComment[]>('GET', `/repos/${owner}/${repo}/pulls/${idx}/reviews/${reviewId}/comments`);
  }
  createReview(owner: string, repo: string, idx: number, opts: { event: 'APPROVED' | 'REQUEST_CHANGES' | 'COMMENT'; body: string; comments?: Array<{ path: string; body: string; new_position?: number; old_position?: number }> }) {
    return this.req<GReview>('POST', `/repos/${owner}/${repo}/pulls/${idx}/reviews`, opts);
  }
  replyToComment(owner: string, repo: string, idx: number, commentId: number, body: string) {
    return this.req<GReviewComment>('POST', `/repos/${owner}/${repo}/pulls/${idx}/comments/${commentId}/replies`, { body });
  }
  resolveComment(owner: string, repo: string, commentId: number) {
    return this.req('POST', `/repos/${owner}/${repo}/pulls/comments/${commentId}/resolve`);
  }

  /** All review comments (with review metadata), oldest review first. */
  async allReviewComments(owner: string, repo: string, idx: number): Promise<Array<{ review: GReview; comment: GReviewComment }>> {
    const reviews = await this.listReviews(owner, repo, idx);
    const out: Array<{ review: GReview; comment: GReviewComment }> = [];
    for (const review of reviews) {
      for (const comment of await this.listReviewComments(owner, repo, idx, review.id)) out.push({ review, comment });
    }
    return out;
  }

  /**
   * Feedback the agent still has to address: inline threads with no resolver (a thread = path+line,
   * resolved if any comment in it is resolved), from non-dismissed reviews, not written by the agent.
   * The body of the latest non-dismissed "request changes" review is returned first as a general item (id 0).
   */
  async unresolvedComments(owner: string, repo: string, idx: number, agentLogin: string): Promise<UnresolvedComment[]> {
    const reviews = await this.listReviews(owner, repo, idx);
    const live = reviews.filter((r) => !r.dismissed);
    const all: Array<{ review: GReview; comment: GReviewComment }> = [];
    for (const review of reviews) {
      for (const comment of await this.listReviewComments(owner, repo, idx, review.id)) all.push({ review, comment });
    }
    const key = (c: GReviewComment) => `${c.path}:${c.position || c.original_position}`;
    const resolved = new Set(all.filter(({ comment }) => comment.resolver).map(({ comment }) => key(comment)));
    const out: UnresolvedComment[] = [];
    const lastRejected = [...live].reverse().find((r) => r.state === 'REQUEST_CHANGES' && r.user?.login !== agentLogin);
    if (lastRejected?.body?.trim()) {
      out.push({ id: 0, path: '', line: 0, body: lastRejected.body.trim(), author: lastRejected.user?.login ?? '', diffHunk: '' });
    }
    for (const { review, comment } of all) {
      if (review.dismissed || comment.resolver || comment.user.login === agentLogin || resolved.has(key(comment))) continue;
      out.push({
        id: comment.id,
        path: comment.path,
        line: comment.position || comment.original_position,
        body: comment.body,
        author: comment.user.login,
        diffHunk: comment.diff_hunk ?? '',
      });
    }
    return out;
  }

  // ---- issues/comments/labels ---------------------------------------------------
  comment(owner: string, repo: string, idx: number, body: string) {
    return this.req<GComment>('POST', `/repos/${owner}/${repo}/issues/${idx}/comments`, { body });
  }
  listComments(owner: string, repo: string, idx: number) { return this.all<GComment>(`/repos/${owner}/${repo}/issues/${idx}/comments`); }
  /** Admin: create a user (requires the owner/admin token). */
  adminCreateUser(opts: { username: string; email: string; password: string }) {
    return this.req<{ login: string }>('POST', '/admin/users', { ...opts, must_change_password: false, send_notify: false });
  }
  adminEditUser(username: string, opts: { password?: string; admin?: boolean }) {
    return this.req('PATCH', `/admin/users/${username}`, { ...opts, login_name: username, source_id: 0, must_change_password: false });
  }
  createOrg(name: string) {
    return this.req('POST', '/orgs', { username: name, visibility: 'private', repo_admin_change_team_access: false });
  }
  listTeams(org: string) { return this.req<Array<{ id: number; name: string }>>('GET', `/orgs/${org}/teams`); }
  createTeam(org: string, name: string) {
    return this.req<{ id: number }>('POST', `/orgs/${org}/teams`, {
      name,
      description: 'Slipway reviewers: write access to every review repo, no repo admin',
      permission: 'write',
      units_map: { 'repo.code': 'write', 'repo.pulls': 'write' },
      includes_all_repositories: true,
      can_create_org_repo: false,
    });
  }
  addTeamMember(teamId: number, username: string) { return this.req('PUT', `/teams/${teamId}/members/${username}`); }
  createOrgRepo(org: string, name: string, description = '') {
    return this.req<GRepo>('POST', `/orgs/${org}/repos`, { name, description, private: true, auto_init: false, default_branch: 'main' });
  }
  /** Moves a repo (with its PRs, reviews and comments) to another owner. As site admin the transfer is immediate. */
  transferRepo(owner: string, repo: string, newOwner: string) {
    return this.req('POST', `/repos/${owner}/${repo}/transfer`, { new_owner: newOwner });
  }
}
