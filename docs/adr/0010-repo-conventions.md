# 0010. Repository conventions for PRs and branch names

Date: 2026-11-08 · Status: accepted

## Context
Repositories have their own rules for PR titles and descriptions (templates, CONTRIBUTING, commitlint, CI checks) and often for
branch names. What Slipway promotes should look like any other PR in that repository.

## Decision
- `slipway_repo_conventions` collects the raw rules with their sources: PR templates, CONTRIBUTING, CLAUDE.md/AGENTS.md, commitlint
  config, CI workflows that check PR titles or branch names, and git hooks (husky, lefthook, pre-commit) that mention branches. Without
  a PR template it adds Slipway's default template.
- Interpretation is left to the model through the skills: the repository's rules win over Slipway's defaults.
- `slipway_start_task` takes an optional `branch` named by those rules; without one it uses `agent/<task_id>-<slug>`. The name must be
  a valid branch and not the base. The branch keeps its name on GitHub after promotion.

## Consequences
Promoted PRs follow the repository's conventions. A misread rule is caught by the repository's own CI on GitHub, and the user can
always name the branch explicitly.
