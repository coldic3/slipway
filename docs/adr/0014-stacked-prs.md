# 0014. Stacked PRs: approval after a base change, promotion to the PR's base

Date: 2026-11-12 · Status: accepted · Amends [0006](0006-exact-promotion.md)

## Context
Agents split big PRs into stacks (1.1 → 1.2 → phase 2) and retarget them. Changing a PR's base changes the diff the reviewer saw,
but Gitea 28 keeps the approval (not dismissed, not stale), and the approval check only compared the head commit. Promotion also
targeted the repo base, not the PR's base, so a stacked PR would reach GitHub with its parent's commits.

## Decision
- An approval counts only if it was submitted after the PR's last base change, read from the Gitea timeline
  (`change_target_branch`). A timeline that cannot be read means not approved for promotion.
- The agent may change the base of any open PR, also an approved one; the approval then no longer counts.
- Promotion targets the PR's base in Gitea. A target that is missing on GitHub or already merged there is refused with
  instructions: promote the parent first, or retarget the child, rebase and get a fresh approval. Slipway never retargets PRs on
  its own.
- The agent may close any open PR, with a reason posted as a comment.

## Consequences
- Each PR of a stack reaches GitHub with only its own commits and a secret scan of exactly that range.
- Retargeting always costs a fresh approval, even when the diff is unchanged (parent merged as is).
- Bases other than the repo base are not mirrored from GitHub (ADR 0008 is unchanged); they are agent branches in Slipway.
