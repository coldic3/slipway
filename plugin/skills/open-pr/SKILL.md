---
name: open-pr
description: Use when work in a Slipway repo is ready for review, or when the user asks to open a PR there. Opens the PR in the local Slipway Gitea, never on GitHub, with a title and description that follow the repository's own PR conventions.
---

# Open a Slipway PR

1. Make sure everything is committed (`git status` is clean) and you are on your task branch. The commits are exactly what will
   reach GitHub: give them clean, meaningful messages that follow the repo's commit conventions, and squash work-in-progress commits first.
2. Call `slipway_repo_conventions` (with `cwd`). Read every rule it returns. **The repository's rules win**:
   - Fill the repo's PR template section by section. Keep its headings; do not invent a different structure.
   - Apply title rules from CONTRIBUTING, CLAUDE.md/AGENTS.md, commitlint or PR-title CI checks
     (e.g. conventional-commit `feat(scope): …`, a ticket key, length limits).
   - Only when the repo has no template, use the Slipway default template it returns.
3. Write an honest description: the context and why, what changed, how you tested it (commands you actually ran),
   and open questions for the reviewer.
4. Call `slipway_open_pr` with `cwd`, `title`, `body`.
5. Tell the user the PR number and the Gitea link, and that it is waiting for their review.
   Do not promote it yourself.

If a PR already exists for the branch, the tool says so: use `slipway_update_pr` to fix the title/description instead.

## Stacked and split PRs

- **Stacked PR** (builds on another open PR): open it with `base` = the parent PR's branch, so the diff shows only its own changes.
- **Splitting a PR** into several: open the new PRs as a stack, then close the old one with `slipway_close_pr` and a `reason`
  naming the new PRs ("Superseded by #7 and #8"), and retarget PRs that were stacked on it with `slipway_update_pr` `base`.
  Retargeting an approved PR is allowed, but the user must approve it again: say so.
- **Check the result yourself** with `slipway_list_prs` (head → base, state) and `slipway_pr` (description, commits, reviews,
  comments, timeline). Do not ask the user for screenshots of Gitea.

