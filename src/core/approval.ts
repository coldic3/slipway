export interface ReviewLike {
  user: { login: string } | null;
  state: string;
  commit_id?: string;
  dismissed: boolean;
}

/**
 * Authoritative approval check used before promotion: the owner's latest verdict (APPROVED / REQUEST_CHANGES,
 * not dismissed) must be APPROVED and must be for the current head commit. Labels are only a display of state;
 * the agent can edit labels, so they are never trusted for this decision.
 */
export function isApprovedByOwner(reviews: ReviewLike[], owner: string, headSha: string): boolean {
  const verdicts = reviews.filter((r) => r.user?.login === owner && !r.dismissed && (r.state === 'APPROVED' || r.state === 'REQUEST_CHANGES'));
  const last = verdicts.at(-1);
  return !!last && last.state === 'APPROVED' && (!last.commit_id || last.commit_id === headSha);
}

export type PrState = 'in-review' | 'changes-requested' | 'approved' | 'closed';

/** PR state derived from the owner's reviews at the current head (no labels). */
export function prStateFromReviews(reviews: ReviewLike[], owner: string, headSha: string, open: boolean): PrState {
  if (!open) return 'closed';
  if (isApprovedByOwner(reviews, owner, headSha)) return 'approved';
  const last = reviews.filter((r) => r.user?.login === owner && !r.dismissed && (r.state === 'APPROVED' || r.state === 'REQUEST_CHANGES')).at(-1);
  if (last?.state === 'REQUEST_CHANGES' && (!last.commit_id || last.commit_id === headSha)) return 'changes-requested';
  return 'in-review';
}
