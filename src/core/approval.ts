export interface ReviewLike {
  user: { login: string } | null;
  state: string;
  commit_id?: string;
  dismissed: boolean;
  submitted_at?: string;
}

export interface TimelineLike { type: string; created_at: string }

export interface ApprovalOptions {
  /**
   * Epoch ms of the PR's last base change (ADR 0014): a verdict counts only if submitted strictly after it. Gitea keeps an
   * approval when the base changes, although the diff the reviewer saw is gone.
   */
  notBefore?: number;
}

const verdictsOf = (reviews: ReviewLike[], owner: string, o: ApprovalOptions) =>
  reviews.filter((r) => r.user?.login === owner && !r.dismissed && (r.state === 'APPROVED' || r.state === 'REQUEST_CHANGES')
    && (o.notBefore === undefined || Date.parse(r.submitted_at ?? '') > o.notBefore));

/**
 * Authoritative approval check used before promotion: the owner's latest verdict (APPROVED / REQUEST_CHANGES,
 * not dismissed, after the last base change) must be APPROVED and must be for the current head commit. Labels are only a
 * display of state; the agent can edit labels, so they are never trusted for this decision.
 */
export function isApprovedByOwner(reviews: ReviewLike[], owner: string, headSha: string, o: ApprovalOptions = {}): boolean {
  const last = verdictsOf(reviews, owner, o).at(-1);
  return !!last && last.state === 'APPROVED' && (!last.commit_id || last.commit_id === headSha);
}

export type PrState = 'in-review' | 'changes-requested' | 'approved' | 'closed';

/** PR state derived from the owner's reviews at the current head (no labels). */
export function prStateFromReviews(reviews: ReviewLike[], owner: string, headSha: string, open: boolean, o: ApprovalOptions = {}): PrState {
  if (!open) return 'closed';
  if (isApprovedByOwner(reviews, owner, headSha, o)) return 'approved';
  const last = verdictsOf(reviews, owner, o).at(-1);
  if (last?.state === 'REQUEST_CHANGES' && (!last.commit_id || last.commit_id === headSha)) return 'changes-requested';
  return 'in-review';
}

/** Epoch ms of the latest base change in a PR timeline, if any. */
export function lastBaseChangeAt(timeline: TimelineLike[]): number | undefined {
  const times = timeline.filter((e) => e.type === 'change_target_branch').map((e) => Date.parse(e.created_at));
  return times.length ? Math.max(...times) : undefined;
}

export interface Approval {
  state: PrState;
  approved: boolean;
  /** The reviewer approved this head, but the base changed afterwards. */
  baseChangedAfterApproval?: boolean;
  /** Set when the timeline could not be read (the approval then does not count). */
  warning?: string;
}

export interface ApprovalSource {
  listReviews(owner: string, repo: string, idx: number): Promise<ReviewLike[]>;
  timeline(owner: string, repo: string, idx: number): Promise<TimelineLike[]>;
}

/** The single approval rule for promotion and every tool: reviews at the head, after the last base change (ADR 0014). */
export async function approvalOf(
  gitea: ApprovalSource, owner: string, repo: string,
  pr: { number: number; head: { sha: string }; state: string }, approver: string,
): Promise<Approval> {
  const reviews = await gitea.listReviews(owner, repo, pr.number);
  const open = pr.state === 'open';
  let notBefore: number | undefined;
  try {
    notBefore = lastBaseChangeAt(await gitea.timeline(owner, repo, pr.number));
  } catch (e) {
    const state = prStateFromReviews(reviews, approver, pr.head.sha, open);
    return {
      state: state === 'approved' ? 'in-review' : state, approved: false,
      warning: `could not read the PR timeline (${(e as Error).message}), so the approval does not count`,
    };
  }
  const state = prStateFromReviews(reviews, approver, pr.head.sha, open, { notBefore });
  const approved = state === 'approved';
  const baseChangedAfterApproval = open && !approved && notBefore !== undefined && isApprovedByOwner(reviews, approver, pr.head.sha);
  return { state, approved, ...(baseChangedAfterApproval ? { baseChangedAfterApproval } : {}) };
}
