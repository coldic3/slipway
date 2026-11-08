# Customizing Gitea 28 (verified 2026-11-07)

- Custom path in the rootless image: `/var/lib/gitea/` (`custom/public/...` is served under `/assets/...`; `custom/templates/...` overrides).
  A read-only bind mount over the data volume works.
- List and extract built-in templates: `gitea embedded list` (no glob arg; pipe to grep), then
  `mkdir -p /tmp/x && gitea embedded extract --destination /tmp/x --overwrite "templates/user/auth/signin.tmpl"`.
- Extension points: `templates/custom/{header,footer,extra_links,extra_links_footer,extra_tabs,body_*}.tmpl`.
  `header.tmpl` goes into `<head>` and has `.IsSigned`.
- **Gitea's CSP blocks inline `<script>`**: put JS in `custom/public/assets/js/*.js` and pass data through `<meta>` tags.
- Root-section settings via env use an empty section: `GITEA____APP_NAME` (`GITEA__DEFAULT__APP_NAME` creates a bogus `[DEFAULT]` section).
- Theme CSS files are content-hashed (`theme-gitea-dark.<hash>.css`), so a custom theme can't `@import` them. Keep `gitea-dark` and override
  `--color-*` variables in our own stylesheet.
- Navbar: Issues disappears when `repo.issues` is globally disabled; Milestones stays while pulls are enabled (hidden by CSS).
  Explore and Help are always rendered (hidden by CSS).
- The "Start timer" button is time tracking (`[service] ENABLE_TIMETRACKING`/`DEFAULT_ENABLE_TIMETRACKING`).
  The passkey frame on sign-in is `[service] ENABLE_PASSKEY_AUTHENTICATION`.
- Repo-header Watch/Star/Fork come from `templates/repo/header/{watch,star,fork}.tmpl`; empty overrides remove them.
- Templates in `custom/templates` are loaded at startup (prod mode): after changing them, restart Gitea (`docker compose -p slipway restart gitea`). CSS/JS/images in `custom/public` are served live.
- Gitea serves `custom/public` assets with `Cache-Control: max-age=21600` (6 h): a changed `slipway.css` stays stale in browsers. Templates reference our assets with a content hash `?v=…`, stamped by `npm run build:brand` (`scripts/stamp-assets.mjs`); `tests/functional/brand-assets.test.ts` fails when a stamp is stale. Fresh Playwright browsers never show this bug.
- Avatars (verified on Gitea 28.3, 2026-11-08): `[server] OFFLINE_MODE` defaults to true and also turns Gravatar off (the default of
  `[picture] DISABLE_GRAVATAR` follows it). With `OFFLINE_MODE=false` + `DISABLE_GRAVATAR=false`, user and commit-author avatars become
  `https://secure.gravatar.com/avatar/<sha256>?d=identicon&s=N`. Gitea sends no CSP header, so the browser loads them fine. `slipway up`
  recreates the container with the new env; no restart of data is needed.
