# 0009. Push guard: the hook follows the branch's Slipway PR

Date: 2026-11-08 · Status: accepted

## Context
An agent can push to GitHub or open a GitHub PR by habit. After promotion, though, the PR is reviewed on GitHub and follow-up work
there (push a fix, reply to a comment) must not be blocked.

## Decision
The hook guards only what publishes code or a PR: `git push`, `gh pr create/ready/merge`, and the `gh api` endpoints and GraphQL
mutations that do the same. For those, in a registered repo, it finds the target branch and asks Slipway for its PRs:
- **an open PR** → blocked (use `slipway_push`, `slipway_update_pr`, `slipway_promote`);
- **no PR** → blocked (the work was never reviewed);
- **only closed PRs** → allowed. Promotion closes the Slipway PR, so this means "promoted"; a PR the reviewer closed counts the same.

Pushes that cannot be narrowed to PR branches (`--all`, `--mirror`, tags, globs), a detached HEAD, an unknown GitHub PR head or an
unreachable Slipway → blocked (fail closed).

Publishing through `gh api` means: REST `POST …/pulls`, `…/pulls/N/merge|update-branch`, `…/merges`, `…/git/refs|commits|trees|blobs|tags`,
`…/contents/…`; GraphQL mutations that create, merge, ready or auto-merge a PR, update its branch, create commits or write refs.
GraphQL always POSTs, so its document decides (inline, heredoc or `--input`/`@file`); an unreadable document, or a mutation whose
fields cannot be told, counts as publishing. Everything else passes: reviews, comments, replies, resolving threads, labels, editing or
closing a PR, issues, explicit `-X GET`. They publish no code, and a branch with an open Slipway PR has no GitHub PR to discuss yet. Promotion from the shell and reading Slipway's credentials are always blocked.

## Consequences
After promotion the agent works with GitHub reviewers directly. Each guarded command costs one Slipway API call. Reusing a promoted
branch name for new work would slip through; branches are per task, so this is accepted. The agent can review and comment on
colleagues' GitHub PRs from a registered repo. A new publishing endpoint or mutation on GitHub passes until it is added to the list.
