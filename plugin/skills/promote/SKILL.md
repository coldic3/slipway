---
name: promote
description: Use when the user asks to promote, ship or send an approved Slipway PR to GitHub. Promotion publishes exactly the reviewed commits; if the base moved, rebase in Slipway with the user first.
---

# Promote a Slipway PR to GitHub

Promotion publishes **exactly** the commits the user approved: no rebase, no squashing, no fixup folding.

1. Call `slipway_status` (with `cwd`). The PR state must be **approved**. If it isn't, tell the user it needs their approval
   in Gitea first; do not try to work around it.
2. Call `slipway_promote` with `cwd` (and `pr` if needed). Options, only when the user asked: `draft: true`, `base`,
   `test_cmd` (e.g. the repo's test command).
3. On success, give the user the GitHub PR URL (a PR that already existed for the branch is updated, not duplicated).
4. If it is blocked, follow what the tool says:
   - **Behind the base:** `main` on GitHub moved. Rebase in Slipway, **interactively with the user**:
     1. `git fetch origin` and `git rebase origin/<base>`.
     2. For every conflict, show the user the conflicting hunks and your proposed resolution. When the right resolution
        is not obvious, ask before continuing. Never resolve silently by taking "ours" or "theirs".
     3. Run the tests, then `slipway_push` with `force_with_lease: true`.
     4. Tell the user the PR needs their approval again (any rebase does), and promote only after they approve.
   - **Not approved:** ask the user to approve the current commit.
   - **Secrets found:** remove them from the branch history (not just the last commit), force-push with lease, tell the user which
     credential must be rotated, and wait for re-approval.
   - **Tests failed:** fix (folding the fix into the right commit), force-push with lease, wait for re-approval.
   - **GitHub branch has commits that are not in the Slipway PR:** tell the user; they decide how to bring them in.
5. Before promotion, never use `gh pr create`, `git push origin` or any other way to GitHub: promotion is the only path.
6. After promotion the Slipway PR is closed and the branch lives on GitHub. Follow-up work for GitHub reviewers (fixes, replies)
   goes straight to GitHub on that branch (`git push origin <branch>`, `gh pr comment`, …), still following the repo's own rules.
