---
name: start-task
description: Use when starting a coding task in a repository reviewed through Slipway (slipway_status works there), before writing code, to create the task's worktree and agent branch so the work can later be opened as a Slipway PR.
---

# Start a Slipway task

1. Call `slipway_status` with `cwd` = your current working directory.
   - If it says the repo is not a Slipway repo or Slipway is not set up, tell the user the command it names and stop.
2. Pick a task id (the ticket/issue the user gave, otherwise a short number) and a kebab-case slug.
3. Call `slipway_repo_conventions` with `cwd`. If the repository defines how branches are named (CONTRIBUTING, CLAUDE.md/AGENTS.md,
   a branch-name CI check or git hook), build the branch name by that rule, e.g. `feature/DRY-12-add-login`. The user's own
   instruction about the branch name wins. No rule: leave the branch out.
4. Call `slipway_start_task` with `cwd`, `task_id`, `slug` and, when step 3 gave one, `branch`. It creates (or reuses) a worktree
   **inside the project** at `.slipway/worktrees/<task_id>-<slug>`, from the fresh base, on that branch or, without one, on
   `agent/<task_id>-<slug>`. The branch keeps its name on GitHub after promotion.
5. `cd` into the returned path and stay there. Pass that path as `cwd` to every `slipway_*` tool from now on.
6. Follow the repository's own rules (CLAUDE.md, AGENTS.md, CONTRIBUTING) for code and commit messages.
   Commit in small, descriptive commits. They go to GitHub as they are, so keep the history clean as you work.
7. Never `git push` and never use `gh pr …` here: Slipway pushes to the local review Gitea, and GitHub only gets the
   PR after the user approves it (once promoted, the branch lives on GitHub; see the `promote` skill). When the work is ready, use the `open-pr` skill.
