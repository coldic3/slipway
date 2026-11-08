# 0008. Base branch follows GitHub

Date: 2026-11-08 · Status: accepted

## Context
After a promoted PR is merged on GitHub, Slipway's base branch would fall behind, and the next PR would show commits that are already
on GitHub.

## Decision
`slipway_start_task`, `slipway_push` and `slipway_open_pr` first mirror GitHub's base into Slipway's base (fetch `origin`, push to
Gitea as `admin`, the only account allowed to push the protected base). A failed sync (offline, auth) never blocks the work; the tool
result carries a warning. `slipway sync-main` does the same by hand.

## Consequences
PR diffs in Slipway are always against the current GitHub base, at the cost of one `git fetch` per call.
