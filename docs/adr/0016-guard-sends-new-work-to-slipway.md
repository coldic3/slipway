# 0016. The guard sends new work to Slipway instead of asking

Date: 2026-11-16 · Status: accepted · Amends [0013](0013-guard-asks-when-unsure.md)

## Context
ADR 0013 asks the user about every guarded write on a branch without a Slipway PR that is not the session's task branch. Most of
those are not a real choice: Claude made a new branch in the main checkout, or ran `gh pr create` out of habit, and the answer is
always "put it in Slipway". In Claude Code's auto mode a hook "ask" still prompts, so these questions stop an otherwise unattended
session for something Claude can settle on its own.

## Decision
- A guarded write on a branch without a Slipway PR is **denied with the way into Slipway** (`slipway_push`, then
  `slipway_open_pr`, checking out the branch first when it is not the current one) when it is new work:
  - the session's task branch (as before);
  - a new PR: `gh pr create`, or `gh api` on `repos/…/pulls`, whatever the branch;
  - a branch GitHub does not have yet: no `refs/remotes/origin/<branch>` in the clone. A local lookup, no network.
- The reason tells Claude not to ask the user about GitHub, and to tell the user to run the command themselves only if they
  explicitly said the branch must skip the review.
- Still **asked**: the base branch (a hotfix), branches GitHub already has (a colleague's PR, work from outside Slipway), and
  everything else ADR 0013 asks (tags, many branches, deletions, detached HEAD, unknown PR heads, an unreachable Slipway). A failed
  lookup counts as "on GitHub", so it is asked rather than denied.

## Consequences
- The common habit (pushing a fresh branch or opening a PR on GitHub) no longer stops auto mode: Claude reroutes to Slipway.
- A user who really wants a new branch on GitHub without review runs the push themselves; Claude cannot get it through a prompt.
- A stale remote-tracking ref (a branch deleted on GitHub but not pruned) makes the branch look existing, so it is asked.
- With Slipway unreachable the hook still asks, since it cannot tell whether a PR exists.
