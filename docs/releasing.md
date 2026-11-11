# Releasing Slipway

One version everywhere (ADR 0011): `package.json`, `plugin/.claude-plugin/plugin.json` and the plugin entry in
`.claude-plugin/marketplace.json`. A unit test keeps them equal; the release workflow checks them against the tag.

## One-time setup

1. **Homebrew tap**: create the public repo `coldic3/homebrew-tap` (empty is fine). Create a fine-grained token with
   *Contents: read and write* on that repo only, and save it in `coldic3/slipway` → Settings → Secrets → Actions as `HOMEBREW_TAP_TOKEN`.
2. **npm** uses Trusted Publishing (OIDC from GitHub Actions, with provenance): there is no npm token. On npmjs.com, in the package
   `@coldic3/slipway` → *Settings* → *Trusted Publisher* → *GitHub Actions*: organization or user `coldic3`, repository `slipway`,
   workflow filename `release.yml`, no environment, and under *Allowed actions* check **Allow `npm publish`** (without it the
   publisher may only stage a release and the workflow fails with `403 … OIDC permission denied for this action`). Then set the
   repository variable `NPM_TRUSTED_PUBLISHING` to `true` (`gh variable set NPM_TRUSTED_PUBLISHING -R coldic3/slipway -b true`).
   npm configures a trusted publisher on an existing package, so the very first version is published by hand from the release
   tarball (see below). A new trusted publisher must be validated by one publish from the workflow within the deadline npmjs.com
   shows.
3. The repo must be **public** before `brew install` and `/plugin marketplace add coldic3/slipway` work for others (both download from
   GitHub without credentials).

Without `HOMEBREW_TAP_TOKEN` the tap update is skipped; without `NPM_TRUSTED_PUBLISHING` the npm publish is skipped. The GitHub
release with the package tarball is always created.

**First npm version** (the package does not exist yet, so no trusted publisher): after the tag's workflow created the release,

```bash
npm login   # with 2FA
gh release download vX.Y.Z -R coldic3/slipway -p '*.tgz' -D /tmp/slipway-release
npm publish /tmp/slipway-release/coldic3-slipway-X.Y.Z.tgz --access public
```

then configure the trusted publisher and the variable as above.

## Each release

```bash
# bump the version in the three files, then:
npm run typecheck && npm test && npm run test:e2e
npm run build:plugin && git diff --exit-code plugin/dist
git commit -am "chore: release X.Y.Z"
git tag vX.Y.Z && git push origin main vX.Y.Z
```

`.github/workflows/release.yml` then tests, runs `npm pack` (which bundles the CLI), creates the GitHub release with
`coldic3-slipway-X.Y.Z.tgz`, renders `packaging/homebrew/slipway.rb` into the tap and publishes the same tarball to npm.

If a step fails (e.g. npm), fix the cause and re-run the failed job (`gh run rerun <run id> --failed`). Each step skips what is
already done: an existing release is reused with its own tarball, an unchanged tap formula is not committed, and a version already
on npm is not published again.

Plugin users get the new plugin with `/plugin marketplace update slipway` + `/plugin update slipway@slipway` (the marketplace is
this repo's `main`).

## What ships

- npm/Homebrew package: `dist/slipway.mjs` (the bundled CLI, no runtime dependencies), `gitea/` (branding),
  `docker/compose.yaml`, `README.md`, `LICENSE`, `package.json`. `tests/functional/package.test.ts` fails on anything else.
- Claude Code plugin: `plugin/` only (the marketplace is added with a sparse checkout of `.claude-plugin` and `plugin`).
- No Slipway Docker image: the Docker runtime uses the official `gitea/gitea` image.

## Bumping Gitea or gitleaks

Change `GITEA_VERSION` / `GITLEAKS_VERSION` and the sha256 sums in `src/runtime/downloads.ts` (from `dl.gitea.com/gitea/<v>/*.sha256`
and the gitleaks `checksums.txt`), the image tag in `docker/compose.yaml` (a unit test checks they match), the gitleaks version in the
workflows and `GITLEAKS_IMAGE` in `src/promote/secrets.ts`. Check the templates in `gitea/templates` against the new Gitea and
run the e2e suite on both runtimes.
