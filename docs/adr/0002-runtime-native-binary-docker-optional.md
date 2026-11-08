# 0002. Runtime: native binary by default, Docker optional, port 3514

Date: 2026-11-08 · Status: accepted

## Context
Slipway should install like a normal program, without requiring Docker. Gitea is a single Go binary published for macOS and Linux
(x64, arm64) with sha256 sums. Port 3000 is the busiest development port there is.

## Decision
- **Two runtimes behind one interface** (`src/runtime/`): `native` (default) and `docker` (`--docker` / `SLIPWAY_RUNTIME=docker`). The
  settings table renders `app.ini` for native and a `GITEA__section__KEY` env file for Docker, so the two cannot drift.
- **Native**: the pinned Gitea (version and sha256 per platform in `src/runtime/downloads.ts`; a mismatch is rejected) is downloaded
  once to `~/.slipway/bin`. It runs detached as the user with `HTTP_ADDR = 127.0.0.1` and data in `~/.slipway/gitea`. Its secrets are
  generated once and kept in `secrets.json` (0600), because `app.ini` is rewritten on every `up`. The branding is copied to
  `~/.slipway/gitea/custom` (both runtimes use the copy). `down` stops the recorded pid only if it is a Gitea process.
- **Docker**: the official rootless image (same version), published on `127.0.0.1` only, `restart: unless-stopped`.
- **No OS service.** After a reboot the plugin's MCP server starts the recorded native Gitea before its first call; `slipway up` does
  the same from the shell.
- **Instance record** `~/.slipway/instance.json` (`runtime`, `port`, `giteaBin`), so later commands need no flags. Switching the runtime
  of an existing instance is refused (data does not move): `slipway down --purge` first.
- **Port 3514 by default.** Order: `--port` → `SLIPWAY_PORT` → instance → 3514. A busy port is detected before starting and reported
  with the next free port and the exact command; `slipway init` offers it interactively. A new port is saved, and `config.json` and
  the `review` remote of every registered clone follow it.

## Consequences
No Docker needed; the first `up` downloads about 110 MB. The 127.0.0.1-only rule holds in both runtimes and is checked by e2e from the
machine's other addresses. CI runs the e2e suite on both runtimes.
