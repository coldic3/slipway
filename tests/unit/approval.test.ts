import { describe, expect, it } from 'vitest';
import { isApprovedByOwner } from '../../src/core/approval.ts';

const r = (id: number, login: string, state: string, commit = 'head', dismissed = false) =>
  ({ id, user: { login }, state, commit_id: commit, dismissed, body: '', submitted_at: `2026-01-0${id}` });

describe('isApprovedByOwner', () => {
  it('true when the latest owner verdict is APPROVED on the current head', () => {
    expect(isApprovedByOwner([r(1, 'kevin', 'REQUEST_CHANGES', 'old'), r(2, 'kevin', 'APPROVED')], 'kevin', 'head')).toBe(true);
  });
  it('false when the approval is for an older commit (pushed after approval)', () => {
    expect(isApprovedByOwner([r(1, 'kevin', 'APPROVED', 'old')], 'kevin', 'head')).toBe(false);
  });
  it('false when a later owner review requested changes', () => {
    expect(isApprovedByOwner([r(1, 'kevin', 'APPROVED'), r(2, 'kevin', 'REQUEST_CHANGES')], 'kevin', 'head')).toBe(false);
  });
  it('ignores plain comments after an approval', () => {
    expect(isApprovedByOwner([r(1, 'kevin', 'APPROVED'), r(2, 'kevin', 'COMMENT')], 'kevin', 'head')).toBe(true);
  });
  it('ignores approvals by anyone else (e.g. the agent) and dismissed reviews', () => {
    expect(isApprovedByOwner([r(1, 'agent-bot', 'APPROVED')], 'kevin', 'head')).toBe(false);
    expect(isApprovedByOwner([r(1, 'kevin', 'APPROVED', 'head', true)], 'kevin', 'head')).toBe(false);
  });
});

import { prStateFromReviews } from '../../src/core/approval.ts';

describe('prStateFromReviews', () => {
  it('closed / approved / changes-requested / in-review', () => {
    expect(prStateFromReviews([r(1, 'kevin', 'APPROVED')], 'kevin', 'head', false)).toBe('closed');
    expect(prStateFromReviews([r(1, 'kevin', 'APPROVED')], 'kevin', 'head', true)).toBe('approved');
    expect(prStateFromReviews([r(1, 'kevin', 'REQUEST_CHANGES')], 'kevin', 'head', true)).toBe('changes-requested');
    // changes were requested on an older commit; Claude pushed since → back in review
    expect(prStateFromReviews([r(1, 'kevin', 'REQUEST_CHANGES', 'old')], 'kevin', 'head', true)).toBe('in-review');
    expect(prStateFromReviews([r(1, 'kevin', 'APPROVED', 'old')], 'kevin', 'head', true)).toBe('in-review');
    expect(prStateFromReviews([], 'kevin', 'head', true)).toBe('in-review');
  });
});
