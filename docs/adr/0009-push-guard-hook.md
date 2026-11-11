# 0009. Push guard: the hook follows the branch's Slipway PR

Date: 2026-11-08 · Status: accepted · Amended by [0013](0013-guard-asks-when-unsure.md) (deny, ask or allow; push target; shell reading)

## Context
An agent can push to GitHub or open a GitHub PR by habit. After promotion, though, the PR is reviewed on GitHub and follow-up work
there (push a fix, reply to a comment) must not be blocked.

## Decision
The hook guards only what publishes code or a PR: `git push`, `gh pr create/ready/merge`, and the `gh api` endpoints and GraphQL
mutations that do the same. For those, in a registered repo, it finds the target branch and asks Slipway for its PRs:
- **an open PR** → blocked (use `slipway_push`, `slipway_update_pr`, `slipway_promote`);
- **no PR** → blocked (the work was never reviewed); ADR 0013 narrows this to the session's task branch and asks for the rest;
- **only closed PRs** → allowed. Promotion closes the Slipway PR, so this means "promoted"; a PR the reviewer closed counts the same.

Pushes that cannot be narrowed to PR branches (`--all`, `--mirror`, tags, globs), a detached HEAD, an unknown GitHub PR head or an
unreachable Slipway → blocked (fail closed); ADR 0013 asks the user instead.

Publishing through `gh api` means: REST `POST …/pulls`, `…/pulls/N/merge|update-branch`, `…/merges`, `…/git/refs`, `…/contents/…`
(judged by the branch they write: the PR's head, the merge `head`, the file's `branch`, the ref; bare git objects publish nothing
until a ref points at them); GraphQL mutations that create, merge, ready or auto-merge a PR, update its branch, create commits or write refs.
GraphQL always POSTs, so its document decides (the `query` field, `@file`, `--input` file or heredoc); only a `mutation` operation
counts, not the word in a string, comment or `--jq` filter. An unreadable document, or a mutation whose
fields cannot be told, counts as publishing. Everything else passes: reviews, comments, replies, resolving threads, labels, editing or
closing a PR, issues, explicit `-X GET`. They publish no code, and a branch with an open Slipway PR has no GitHub PR to discuss yet. Promotion from the shell and reading Slipway's credentials are always blocked.

## Consequences
After promotion the agent works with GitHub reviewers directly. Each hook run with a guarded command lists the repo's Slipway PRs once. Reusing a promoted
branch name for new work would slip through; branches are per task, so this is accepted. The agent can review and comment on
colleagues' GitHub PRs from a registered repo. A new publishing endpoint or mutation on GitHub passes until it is added to the list.
