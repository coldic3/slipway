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

import { approvalOf, lastBaseChangeAt } from '../../src/core/approval.ts';

const at = (id: number, login: string, state: string, submitted: string, commit = 'head') =>
  ({ id, user: { login }, state, commit_id: commit, dismissed: false, body: '', submitted_at: submitted });

describe('approval after a base change (ADR 0014)', () => {
  const change = (created_at: string) => ({ type: 'change_target_branch', created_at, old_ref: 'a', new_ref: 'b' });

  it('lastBaseChangeAt picks the latest change_target_branch', () => {
    expect(lastBaseChangeAt([])).toBeUndefined();
    expect(lastBaseChangeAt([change('2026-11-12T10:00:00+01:00'), { type: 'comment', created_at: '2026-11-12T12:00:00+01:00' }, change('2026-11-12T11:00:00+01:00')]))
      .toBe(Date.parse('2026-11-12T11:00:00+01:00'));
  });

  it('an approval older than (or at the same second as) the last base change does not count', () => {
    const notBefore = Date.parse('2026-11-12T11:00:00+01:00');
    expect(isApprovedByOwner([at(1, 'kevin', 'APPROVED', '2026-11-12T10:59:59+01:00')], 'kevin', 'head', { notBefore })).toBe(false);
    expect(isApprovedByOwner([at(1, 'kevin', 'APPROVED', '2026-11-12T11:00:00+01:00')], 'kevin', 'head', { notBefore })).toBe(false);
    expect(isApprovedByOwner([at(1, 'kevin', 'APPROVED', '2026-11-12T11:00:01+01:00')], 'kevin', 'head', { notBefore })).toBe(true);
    expect(prStateFromReviews([at(1, 'kevin', 'APPROVED', '2026-11-12T10:00:00+01:00')], 'kevin', 'head', true, { notBefore })).toBe('in-review');
  });

  it('approvalOf reads reviews and the timeline; an unreadable timeline is not approved', async () => {
    const reviews = [at(1, 'kevin', 'APPROVED', '2026-11-12T10:00:00+01:00')];
    const pr = { number: 3, head: { sha: 'head' }, state: 'open' as const };
    const ok = { listReviews: async () => reviews, timeline: async () => [] };
    expect(await approvalOf(ok, 'repos', 'demo', pr, 'kevin')).toEqual({ state: 'approved', approved: true });
    const moved = { listReviews: async () => reviews, timeline: async () => [change('2026-11-12T11:00:00+01:00')] };
    expect(await approvalOf(moved, 'repos', 'demo', pr, 'kevin')).toMatchObject({ state: 'in-review', approved: false, baseChangedAfterApproval: true });
    const broken = { listReviews: async () => reviews, timeline: async () => { throw new Error('boom'); } };
    expect(await approvalOf(broken, 'repos', 'demo', pr, 'kevin')).toMatchObject({ state: 'in-review', approved: false, warning: expect.stringMatching(/timeline.*boom/) });
  });
});
