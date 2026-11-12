---
name: fix-review
description: Use when the user asks to fix, address or handle the review (comments, requested changes) of a Slipway PR. Reads the unresolved review comments, folds every fix into the commit it belongs to, force-pushes the clean history to Slipway and replies to every thread.
---

# Address a Slipway review

Slipway shows exactly the commits that will reach GitHub, and promotion never rewrites them. So the branch in Slipway must
always be in its final shape: **no `fixup!` commits, no "address review" commits.**

1. Call `slipway_review_comments` (with `cwd`; `pr` if the user named one). It lists:
   - the latest review summary (no `comment_id`; address it but don't reply to it),
   - every unresolved inline thread with `comment_id`, `file:line`, the comment and diff context.
2. For each point:
   - Make the change. If you disagree or a point is unclear, don't guess: explain in the reply instead.
   - Fold it into the commit it belongs to:
     - the last commit: `git commit --amend --no-edit`;
     - an older commit: `git commit --fixup=<sha>` and then, before pushing,
       `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash $(git merge-base HEAD origin/<base>)`.
       For a stacked PR (its base is another PR's branch, see `slipway_pr`), use that local branch instead of `origin/<base>`.
   - Adjust commit messages if the change makes them inaccurate (follow the repo's commit conventions).
3. Check the result: `git log --oneline origin/<base>..HEAD` (or `<parent branch>..HEAD` for a stacked PR) must show only meaningful commits (no `fixup!`). Run the repo's tests/linters.
4. Call `slipway_push` with `force_with_lease: true`. If the lease fails, someone else changed the branch: stop and tell the user.
5. Call `slipway_reply` for **every** `comment_id`: say briefly what you changed (or why not). Never resolve threads; the user does.
6. Re-check the title and description against `slipway_repo_conventions` and the new state of the code. Update them with
   `slipway_update_pr` if needed.
7. Summarize for the user what you changed per comment. Point out that Gitea shows the force-push with a "compare" link, so they can
   review just the changes since their last review.
