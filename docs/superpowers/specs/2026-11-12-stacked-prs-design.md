# Stacked and split PRs: design

Date: 2026-11-12 · Status: approved in chat (Kevin)

## Problem

The Slipway tools assume one PR per branch and a linear loop (open → fix review → promote). When an agent splits one PR into
several or reorganises a stack, it cannot finish the job:

- it cannot **close** a superseded PR (the Gitea client has `closePull`, no tool exposes it);
- it cannot **change the target branch** of a PR (`slipway_open_pr` takes `base`, `slipway_update_pr` does not);
- it cannot **see** PRs other than the current branch's: no list, no base/head, state, body, commits, files, full review
  history, conversation comments or timeline. It asks the user for screenshots;
- **promotion ignores the PR's base in Gitea** (`o.base ?? entry.base`): a stacked PR would go to GitHub against `main`,
  carrying its parent's commits, and gitleaks would scan a range other than the reviewed one.

Gitea 28 does not dismiss or mark stale an approval when the base changes (verified), so the approval check must handle it.

## Goal

From one session the agent can split a PR, close the superseded one, retarget the stack and verify the result in Gitea without
the user's clicks or screenshots. A stack (1.1 → 1.2 → phase 2) promotes one PR at a time, each with only its own diff on GitHub.

Unchanged: no merges in Gitea, promotion only with the reviewer's approval of the current head, exactly the reviewed commits,
approved title/description frozen for the agent.

## Design

### Read tools

- `slipway_list_prs` (`cwd`, `state`: open | closed | all, default open): one line per PR:
  `#N title · head → base · state · unresolved: K`. State is in-review / changes-requested / approved / closed / promoted
  (closed with Slipway's "Promoted to GitHub" comment).
- `slipway_pr` (`cwd`, `pr` default = current branch's PR, `diff` default false): head/base with SHAs, author, state, body,
  commits (sha, subject), changed files (status, +/−), every review (author, state, commit, dismissed, whether it still counts),
  every comment (conversation and inline, inline marked resolved/unresolved), and the timeline (base changes, pushes incl.
  force-pushes, close/reopen). `diff: true` appends Gitea's diff, cut at 100 000 characters with a note.
- `slipway_review_comments` stays the "to do" list for fix-review.

### Write tools

- `slipway_update_pr` gains `base`. The PR must be open; `base` must differ from head (Gitea itself accepts base == head) and
  exist in Gitea (Gitea answers 404 "new base … not exist"). On an approved PR, `base` may change but a call that also sets
  `title`/`body` is refused as a whole. The result states the new diff size and, if the PR was approved, that the approval no
  longer counts.
- `slipway_close_pr` (`cwd`, `pr` required, `reason` required): posts `Closed by <agent>: <reason>`, then closes. Any open PR of
  the repo. Already closed → no-op with its state. Reopening stays in the Gitea UI.
- `slipway_open_pr` validates `base` the same way.

### Approval after a base change

- `GiteaClient.timeline()` reads `GET /repos/{o}/{r}/issues/{n}/timeline`. A base change is an entry
  `type: change_target_branch` with `old_ref`, `new_ref`, `created_at` (written for API and UI changes alike).
- `isApprovedByOwner(reviews, owner, head, { notBefore })`: the reviewer's latest non-dismissed verdict must be APPROVED, for the
  head, and submitted strictly after the last base change. `prStateFromReviews` takes the same option.
- `approvalOf(gitea, owner, repo, pr, approver)` in `core/approval.ts` fetches reviews and timeline and is used by promotion,
  status, list, pr and update_pr. If the timeline cannot be read, promotion fails (not approved) and the tools show in-review with
  a warning.

### Promotion of a stacked PR

- The GitHub target defaults to the PR's base in Gitea. A `base` option that differs from it is refused (the CLI's `--force`
  overrides, as for approval).
- When the target is not the repo base:
  1. the target must exist on GitHub. If not: an open Slipway PR whose head is the target → "promote #N first"; otherwise
     "the target is gone (parent merged?): change the base with slipway_update_pr, rebase, push, get a fresh approval".
  2. the target's GitHub PR must not be merged already; if it is → the same "change the base" message.
- The rest is unchanged: "behind" is checked against `origin/<target>`, gitleaks scans `<target>..head`, the GitHub PR is
  opened with `base = <target>`. When the parent is merged with branch deletion, GitHub retargets the child itself.
- ADR 0008 is unchanged: only the repo base is mirrored from GitHub.

### Skills and docs

- `open-pr`: stacked PRs (open with `base`), splitting a PR (close the old one with a reason, retarget children), verify with
  `slipway_list_prs` / `slipway_pr` instead of asking for screenshots.
- `promote`: promote parents first; after a parent is merged, retarget the child.
- `docs/plugin.md`: the new tools. ADR 0014: stacked PRs.

## Testing

- Unit: approval with `notBefore`; tools (list, pr, update base incl. approved/base==head/missing, close); promote target
  default, base mismatch, missing target with open parent, missing target without parent, merged parent; GitHub client methods.
- e2e (real Gitea): open a stacked PR, retarget it with `slipway_update_pr`, check the timeline-based approval reset after an
  approval, close a PR with a reason, list and inspect PRs.
