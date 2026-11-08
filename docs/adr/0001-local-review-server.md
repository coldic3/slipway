# 0001. Local review server

Date: 2026-11-08 · Status: accepted

## Context
Pull requests from a coding agent need a place to be reviewed before anything reaches GitHub: a real diff view, inline comments,
review verdicts and editable titles and descriptions, on the developer's machine.

## Decision
- Slipway runs a pinned [Gitea](https://about.gitea.com) (28.x) with SQLite as its review server. Gitea 28 has the threaded replies and
  resolve APIs the review loop relies on; older versions are not supported.
- It listens only on `127.0.0.1` (`http://127.0.0.1:<port>`, no local domain or reverse proxy), requires sign-in, has registration,
  SSH and mail disabled, and git goes over HTTP with tokens.
- Every merge style is disabled and the base branch is protected: code leaves Slipway only through promotion (ADR 0006).
- The UI is reduced to what Slipway supports: code and pull requests only (no issues, wiki, releases, packages, actions, forks or
  stars), English only, Slipway branding (logo, dark gray and amber theme, sign-in page), avatars from Gravatar by e-mail.
- All Gitea settings live in one table, `src/runtime/settings.ts`; branding lives in `gitea/`.

## Consequences
Review uses a mature UI without writing one.
Gravatar means an e-mail hash is sent to gravatar.com when a page shows an avatar. Bumping Gitea is a code change
(`docs/releasing.md`) and needs the e2e suite.
