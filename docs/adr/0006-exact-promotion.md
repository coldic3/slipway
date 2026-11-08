# 0006. Exact promotion

Date: 2026-11-08 · Status: accepted

## Context
Promotion is the only way code leaves Slipway. What reaches GitHub must be exactly what was reviewed, so the review is meaningful and
nothing is rewritten after approval.

## Decision
- Promotion requires the reviewer's latest non-dismissed verdict to be an approval **on the PR's current head commit**.
- It pushes the reviewed commits unchanged (same SHAs): no rebase, autosquash or squash at promotion. Slipway holds the final history:
  the `fix-review` skill folds fixes into the right commits and force-pushes with lease, so Slipway never contains `fixup!` commits.
- If the branch does not contain the current GitHub base, promotion stops. The agent rebases in Slipway (resolving conflicts with the
  user), force-pushes and the reviewer approves again: every rebase needs a new approval.
- `slipway_push` force-with-lease leases on the SHA it pushed last (or a Gitea tip this clone already knows), so it never overwrites
  commits it has not seen. The push to GitHub is leased the same way.
- The GitHub PR is created or updated with the title and description read from Slipway right before pushing. Once approved, they are
  frozen for the agent; only the reviewer edits them.
- GitHub access comes from `gh auth token` (or `SLIPWAY_GITHUB_TOKEN`) at promotion time and is never written to disk or returned by a tool.
- A branch that already exists on GitHub is updated, with its PR, when all its commits are contained in the reviewed branch;
  otherwise promotion stops with an explanation. Optional `test_cmd` runs before pushing. Promotion git never runs repository hooks.

## Consequences
The Slipway PR shows exactly what ships, and each force-push gives a compare link for "changes since my last review". A
single-commit PR is made by squashing in Slipway before review. Every rebase costs one approval.
