# Testing knowledge

- gitleaks via Docker (`zricethezav/gitleaks:v8.30.1`) works on macOS temp dirs (`/var/folders/...` is shared with Docker Desktop).
  Use `-e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=*` to avoid the "dubious ownership" error.
- gitleaks cannot scan a git *worktree* mounted alone (its `.git` is a file pointing into the main repo). Scan the main clone
  with `--log-opts <baseSha>..<headSha>` instead: worktrees share the object database.
- gitleaks flags: `git --no-banner --redact --exit-code 1 --report-format json --report-path - --log-opts <range> <dir>`.
  Exit 1 = leaks found, 0 = clean, anything else = error (treat as blocked).
- `git commit -F msg` with default cleanup strips lines starting with `#`, which kills markdown headings in PR bodies.
  Use `--cleanup=whitespace` for squash commits built from PR descriptions.
- Non-interactive autosquash: `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash --force-rebase origin/main`.
- `--force-with-lease=refs/heads/<b>` compares against `refs/remotes/origin/<b>`; fetch it first (ignore failure when absent).
- Isolated git identity in tests: set `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_AUTHOR_*`/`GIT_COMMITTER_*`.
- Promotion git must run with `core.hooksPath=/dev/null` (via `GIT_CONFIG_*` env, see `hardenedGitEnv`): a functional test proved
  `post-checkout`/`pre-push` hooks in the shared `.git` otherwise run during `worktree add`/`push`.
- A real lease for re-promotion: `--force-with-lease=refs/heads/b:<sha-we-pushed-last>` (empty sha = must not exist).
  Fetching the remote right before pushing makes the lease meaningless.
- macOS: `/var` → `/private/var`. `git rev-parse` returns real paths, `os.tmpdir()` does not; compare repo paths with `realpathSync` on both sides.
- Promotion lease for branches that already exist on GitHub (e.g. a PR opened before Slipway): leasing on "must not exist" (empty)
  fails with `rejected (stale info)`. Slipway fetches the GitHub tip to `refs/slipway/github/<branch>` and force-updates only if that tip is an
  ancestor of the reviewed Slipway head (nothing on GitHub gets lost), leasing on the SHA it saw. Otherwise it refuses (PushRejectedError).
