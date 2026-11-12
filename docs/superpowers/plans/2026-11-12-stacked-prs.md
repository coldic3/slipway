# Stacked and split PRs: implementation plan

Spec: `docs/superpowers/specs/2026-11-12-stacked-prs-design.md`. Each step test-first; one commit per step.

1. **Approval after a base change** (`src/core/approval.ts`): `notBefore` option for `isApprovedByOwner` and `prStateFromReviews`;
   `lastBaseChangeAt(timeline)`; `approvalOf()` fetching reviews + timeline. Unit tests in `tests/unit/approval.test.ts`.
2. **Gitea client** (`src/gitea/client.ts`, `types.ts`): `timeline`, `pullCommits`, `pullFiles`, `editPull` with `base`,
   `branchExists`. Unit tests in `tests/unit/gitea-client.test.ts`.
3. **Tools use `approvalOf`**: `stateOf` in `src/mcp/tools.ts` (status, update_pr) and promotion's approval check.
4. **`slipway_update_pr` base** and **`slipway_close_pr`**; `open_pr` base validation. Register in `src/mcp/server.ts`.
5. **`slipway_list_prs`** and **`slipway_pr`**.
6. **Promotion to the PR's base**: default target, base mismatch, GitHub `branchExists` / `mergedPullFor` (`src/github/client.ts`),
   parent hints. Unit tests in `tests/unit/promote.test.ts`, `github-client.test.ts`.
7. **Skills and docs**: `plugin/skills/open-pr`, `promote`, `fix-review` where relevant; `docs/plugin.md`.
8. **e2e**: retarget, approval reset, close, list/pr in `tests/e2e/review-flow.spec.ts` (or a new `stack.spec.ts`).
9. `npm run typecheck`, `npm test`, `npm run build:plugin` (commit `plugin/dist`), `npm run test:e2e`, `claude plugin validate plugin`.
