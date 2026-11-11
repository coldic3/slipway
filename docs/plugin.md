# Using Slipway from Claude Code (plugin)

Install the Slipway plugin once. Then a single Claude Code session runs the whole loop: Claude opens the PR in your local
Gitea, you review it there, you tell Claude to fix the review, and when you've approved, you tell it to promote. The PR appears
on GitHub with the title and description you accepted.

## 1. Install and set up (your terminal)

```bash
brew install coldic3/tap/slipway        # or: npm install -g @coldic3/slipway   (Node 22+)
slipway init
```

`slipway init` asks which agent you use (Claude Code, or none for now), then:

- starts Slipway's Gitea on `http://127.0.0.1:3514`: a pinned Gitea binary, downloaded once (sha256-checked) into `~/.slipway/bin`,
  data in `~/.slipway/gitea`. Prefer Docker? `slipway init --docker`. If port 3514 is taken, it offers the next free port; the port
  you pick is remembered (`slipway up --port N` or `SLIPWAY_PORT` change it later; config and remotes follow);
- creates your login `slipway` / `slipway` (a reviewer, not an admin), the technical `admin` account and the `repos` org;
- installs the Claude Code plugin (`claude plugin marketplace add coldic3/slipway` + `claude plugin install slipway@slipway`);
- offers to register the repository you're in.

Then, per project: `slipway repo add <your-clone>` (origin must point at GitHub), and `gh auth status` (promotion uses your `gh` login).
Open Slipway, log in, and tick **Remember this device** (365 days).

After a reboot you don't need to do anything: the plugin starts Slipway's Gitea on its next call (or run `slipway up`).
With `--docker`, Docker restarts the container itself.

## 2. The plugin (in Claude Code)

`slipway init` installs it. To do it by hand:

```
/plugin marketplace add coldic3/slipway
/plugin install slipway@slipway
```

Restart Claude Code if asked. The plugin brings:

- **MCP tools** `slipway_status`, `slipway_start_task`, `slipway_repo_conventions`, `slipway_push`, `slipway_open_pr`, `slipway_update_pr`,
  `slipway_review_comments`, `slipway_reply`, `slipway_promote`;
- **skills** `slipway:start-task`, `slipway:open-pr`, `slipway:fix-review`, `slipway:promote`;
- **a guardrail hook**: in Slipway repos it stops Claude from publishing its task's work on GitHub before review (`git push` to
  GitHub, `gh pr create/ready/merge` and the matching `gh api` calls) and points it to the Slipway tools. When Slipway cannot settle
  a push (a branch outside the task, `main`, tags, deleting a branch, Slipway not running), it asks you instead of refusing. Once the
  branch's Slipway PR is closed (promotion closes it), the branch lives on GitHub: Claude may push to it and answer GitHub reviewers
  directly. Reviews, comments and other GitHub writes that publish no code, and pushes to other remotes, are never stopped. It also
  stops `slipway promote` from Claude's shell (Claude promotes only through `slipway_promote`) and reads of Slipway's credentials
  (ADR 0009, 0013).

On first use, the plugin creates its own Gitea user for this machine (`claude-<hostname>`, or `SLIPWAY_CLAUDE_USER`).
Its PRs and replies show under that name, and it can push branches but never merge.

## 3. The loop (one Claude session, in your repo)

| You say | Claude does |
|---|---|
| "Implement X for ticket 123" | creates `.slipway/worktrees/123-x` inside the project (git-excluded) on a branch named by the repo's rules (e.g. `feature/123-x`), or `agent/123-x` when it has none; works and commits there |
| "Open a Slipway PR" | reads the repo's PR conventions (template, CONTRIBUTING, commitlint, PR-title checks), writes title + description to them, opens the PR in Gitea |
| *(you review in Gitea: inline comments → Request changes)* | |
| "Fix the review" | reads the unresolved comments, folds every fix into the commit it belongs to (amend / autosquash), force-pushes the clean history to Gitea (with lease), replies to every thread |
| *(you resolve threads and Approve; edit title/description in Gitea if you like)* | |
| "Promote it" | publishes **exactly the reviewed commits** (same SHAs): scans for secrets, optionally runs tests, pushes, opens or updates the GitHub PR |
| *(if `main` moved on GitHub)* | promotion stops; Claude rebases in Slipway with you (asking about each unclear conflict), force-pushes, and you approve again |

Things worth knowing:

- **Your approval is the gate.** `slipway_promote` refuses anything you haven't approved at its current commit. After approval,
  Claude can no longer edit the title or description; you can.
- **Your repo's PR rules win** over Slipway's default template.
- **Slipway's `main` follows GitHub by itself:** starting a task, pushing and opening a PR first update it, so merged promotions
  never show up again in new PR diffs.
- **What you review is what ships.** Slipway never rewrites history at promotion. Gitea shows each force-push with a compare link,
  so after "fix the review" you can look at just what changed.
- **Blocked promotions** report back in the session and as a comment on the PR:
  - the branch is behind the new `main`: Claude rebases in Slipway with you and you approve again (every rebase needs a new approval);
  - a secret found: remove it from the history and rotate it;
  - failed tests.
- Promotion options (just ask): draft PR, other base branch, run a test command first. Want a single commit? Ask Claude to squash in Slipway before you review.
- From your own terminal, the same promotion is `slipway promote my-app <pr>`.

## Scope

Slipway helps you review AI-written code before it reaches GitHub. It guards against mistakes, not against an agent deliberately
working around it: Claude runs as your OS user, with your `gh` login available (ADR 0003).

## Troubleshooting

- Ask Claude for `slipway_status`: it shows Gitea, the repo, the Claude user, the branch's PR and its state.
- `slipway status` in your terminal: running or stopped, port, runtime.
- "not a Slipway repo": run `slipway repo add <clone>`; worktrees of a registered clone work automatically.
- "port … is already in use": another program has it. `slipway up --port <free port>` (Slipway suggests one) moves Slipway there.
- Gitea's own log (native): `~/.slipway/gitea/log/`.
- "GitHub CLI is not logged in": `gh auth login`.
- Updating: `brew upgrade slipway` (or `npm install -g @coldic3/slipway`), `slipway up`, and `/plugin update slipway@slipway` in Claude Code.
- Starting over: `slipway down --purge` deletes all review data (your clones are untouched), then `slipway init`.
