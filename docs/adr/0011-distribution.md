# 0011. Distribution: Homebrew and npm, `slipway init`, one version

Date: 2026-11-08 · Status: accepted

## Decision
- **Package** `@coldic3/slipway` with the command `slipway`: the CLI is bundled with esbuild into `dist/slipway.mjs` (no runtime
  dependencies). The `files` whitelist ships only the bundle, `gitea/`, `docker/compose.yaml`, README and LICENSE; a test fails
  on anything else. macOS and Linux only.
- **Homebrew** tap `coldic3/homebrew-tap` (formula from `packaging/homebrew/slipway.rb`, depends on `node` and `gitleaks`);
  `npm install -g @coldic3/slipway` is the alternative.
- **Release** on a `v*` tag (`.github/workflows/release.yml`): versions must match the tag, tests pass, a GitHub release gets the
  tarball, the tap update (with a tap token) and npm publish through Trusted Publishing (OIDC, provenance, no npm token;
  `docs/releasing.md`). `.gitattributes` keeps docs, tests and
  project notes out of GitHub's source archives.
- **`slipway init`** asks which agent to set up (registry in `src/agents/`: Claude Code, or none), handles a busy port, runs `up` and
  `setup`, installs the agent integration (Claude Code: the marketplace with a sparse checkout of `.claude-plugin` and `plugin`, then
  the plugin) and offers to register the current repository. `--agent`, `--port`, `--docker` and `--yes` make it scriptable.
- **One version** in `package.json`, `plugin.json`, the marketplace entry and the MCP server; a test keeps them equal.
- **MIT** license.

## Consequences
Install is two commands (`brew install …`, `slipway init`). The plugin comes from the marketplace's `main`, so plugin and CLI versions
can differ between releases; both report their version. New agents and Git hosts need adapter interfaces first; Claude Code and
GitHub are built in today.
