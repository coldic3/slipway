# 0009. Push guard: the hook follows the branch's Slipway PR

Date: 2026-11-08 · Status: accepted

## Context
An agent can push to GitHub or open a GitHub PR by habit. After promotion, though, the PR is reviewed on GitHub and follow-up work
there (push a fix, reply to a comment) must not be blocked.

## Decision
For `git push`, `gh pr` writes and `gh api` writes in a registered repo, the hook finds the target branch and asks Slipway for its PRs:
- **an open PR** → blocked (use `slipway_push`, `slipway_update_pr`, `slipway_promote`);
- **no PR** → blocked (the work was never reviewed);
- **only closed PRs** → allowed. Promotion closes the Slipway PR, so this means "promoted"; a PR the reviewer closed counts the same.

Pushes that cannot be narrowed to PR branches (`--all`, `--mirror`, tags, globs), a detached HEAD, an unknown GitHub PR head or an
unreachable Slipway → blocked (fail closed). `gh api graphql` always POSTs, so it counts as a write only when its document (inline,
heredoc or `--input`/`@file`) contains a `mutation`; a document file it cannot read counts as a write. Promotion from the shell and reading Slipway's credentials are always blocked.

## Consequences
After promotion the agent works with GitHub reviewers directly. Each guarded command costs one Slipway API call. Reusing a promoted
branch name for new work would slip through; branches are per task, so this is accepted.
