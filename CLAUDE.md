# CLAUDE.md — Slipway

Slipway is a local waiting room for coding-agent pull requests. Claude Code, through the Slipway plugin (MCP server, skills and hook
in `plugin/`), opens the PR in a local review server (Gitea on 127.0.0.1); the user reviews it there; the approved PR is promoted to
GitHub from the same session, exactly as reviewed. Key decisions: `docs/adr/`. User guide: `docs/plugin.md`. Releasing:
`docs/releasing.md`.

## Product requirements (from Kevin, the maintainer)

- One install and one session: `brew install` / `npm install -g`, then `slipway init`; the whole loop (start task, open PR, fix the
  review, promote) runs from one Claude Code session through the plugin. No per-repo files, no separate agent CLI, no bridge.
- `slipway init` is interactive and asks which agent to set up (Claude Code only for now); `--yes` and flags make it scriptable.
- Gitea runs as a native binary by default, Docker is optional. Default port **3514** (never explain the number anywhere),
  overridable; a busy port gets a clear message with a free alternative.
- Default reviewer login `slipway` / `slipway`. No auto-login; "Remember this device" lasts 365 days.
- The reviewer login is a plain user: no repo Settings, no site administration. Repos belong to the `repos` org, run by a technical
  `admin` account stored only in the config.
- Slipway follows each repository's own rules for PR titles, descriptions and branch names (`agent/<id>-<slug>` only as the default).
- Promotion publishes exactly the reviewed commits: no fixup/autosquash magic at promotion. If the base moved, rebase in Slipway
  (resolving conflicts with the user) and get a fresh approval.
- Slipway's base branch follows GitHub automatically. After promotion, GitHub review happens on GitHub and the hook lets it through.
- It is a workflow aid against agent mistakes, not a firewall against a malicious agent.
- UI: Slipway branding, dark gray and amber, English only, only the features Slipway supports; avatars from Gravatar.
- Public repo `coldic3/slipway`, branch `main`, MIT, macOS and Linux only, one version everywhere. Packages ship only what Slipway
  needs to run (no CLAUDE.md, docs, credentials or ignored files). The README stays short and factual and does not mention Gitea.
- Supported today: Claude Code and GitHub. More agents and Git hosts (e.g. GitLab) will come later, starting with adapter interfaces.
- Outward-facing steps (repo visibility, npm publish, the Homebrew tap, release tags) are Kevin's unless he asks.

## Working rules

1. **Key decisions → ADR** in `docs/adr/NNNN-title.md` (Context / Decision / Consequences), indexed in `docs/adr/README.md`. Only
   architecture-level decisions; README wording, cleanups and renames are not ADRs.
2. **Learnings → `.ai/knowledge/`** as small topic files (Gitea quirks, Claude Code plugin facts, test tricks). Check it before
   re-researching.
3. **Bigger features**: write the spec and plan first (superpowers flow) in `docs/superpowers/` (git-ignored scratch is `.superpowers/`).
4. **Tests live in the repo and run in CI:**
   - `npm run test:unit` (Vitest, `tests/unit`): no network, no Gitea.
   - `npm run test:functional` (Vitest, `tests/functional`): real git and temporary repos, no Gitea.
   - `npm run test:e2e` (Playwright, `tests/e2e`): starts its own isolated Slipway (native Gitea on port 3300;
     `SLIPWAY_E2E_RUNTIME=docker` for Docker) via `slipway init`, drives the bundled MCP server as Claude. CI runs both runtimes.
   - After changing `src/`, run `npm run build:plugin` and commit `plugin/dist` (a test fails on a stale bundle). `dist/` (the CLI
     bundle) is git-ignored and built by `npm pack`.
   - One version in `package.json`, `plugin.json` and the marketplace entry (a test checks).
   - Packages ship only the whitelist in `package.json` `files` (a test checks the packed list).
   - `npm test` runs unit + functional; `npm run test:all` runs everything.
5. **Security invariants (never break):**
   - Gitea binds only to `127.0.0.1`.
   - The GitHub token comes from `SLIPWAY_GITHUB_TOKEN` or `gh auth token` at promote time and is never written to disk or
     returned by a tool (ADR 0003).
   - Promotion only with the reviewer's approval on the PR's current head, and it publishes exactly those commits (never rewrites).
     Approved title/description are frozen for Claude.
   - No merges in Gitea: all merge styles are disabled and `main` is branch-protected.
   - gitleaks failing or missing = promotion blocked (fail closed).
6. Gitea is the source of truth for the PR title/description. Promotion re-reads it right before pushing.
7. Commits: small and descriptive. End each message with the `Co-Authored-By` trailer the harness provides.

## Gotchas (details in `.ai/knowledge/`)

- Gitea settings live in one table, `src/runtime/settings.ts` (app.ini for native, env file for Docker). Don't add them to compose.
- Native Gitea: `~/.slipway/gitea` (app.ini regenerated on each `up`, secrets in `secrets.json`), binaries in `~/.slipway/bin`
  (`SLIPWAY_BIN_DIR`; e2e uses `.e2e-cache/bin`). Details in `.ai/knowledge/native-gitea.md`.
- Gitea 28: `ALLOWED_HOST_LIST` lives in `[security]`.
- Installed Claude Code plugins have no `node_modules`: the MCP server and hook are esbuild bundles in `plugin/dist`.
- Re-running `slipway setup` must keep valid tokens, the stored reviewer login and the enrolled Claude user.
- Squash commits from PR bodies need `git commit --cleanup=whitespace` (default cleanup strips `## headings`).
- macOS `/var` → `/private/var`: compare repo paths with realpath.
- Gitea branding lives in `gitea/` (copied to `~/.slipway/gitea/custom` on `up`); after changing its CSS/JS run
  `npm run build:brand` (cache-busting `?v=` stamps; browsers cache assets 6 h) and restart Gitea after template changes; Gitea's CSP
  blocks inline scripts; root-section env is `GITEA____APP_NAME`.
- e2e: one shared stack, `workers: 1`; set `SLIPWAY_E2E_KEEP=1` to inspect it (`SLIPWAY_HOME=.e2e-tmp/home bin/slipway status`).
- Kevin's own instance runs on the Docker runtime, port 3030 (`~/.slipway/instance.json`).

## Commands

```bash
npm install
npm run typecheck
npm test                 # unit + functional
npm run test:e2e         # Playwright (native Gitea; SLIPWAY_E2E_RUNTIME=docker for Docker)
bin/slipway --help       # the CLI from source (installed: `slipway`)
npm run build:plugin     # after src/ changes
npm run build:cli        # dist/slipway.mjs (npm pack runs it)
claude plugin validate plugin
```
