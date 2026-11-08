# Running Gitea natively (ADR 0002)

- Release binaries: `https://dl.gitea.com/gitea/<v>/gitea-<v>-<os>-<arch>` with `.sha256` next to them. macOS names are
  `darwin-arm64` / `darwin-amd64` (not `darwin-10.12-*`; that 404s for 28.x). Also `.xz` variants, but Node has no xz decoder and
  macOS has no `xz` by default, so Slipway downloads the plain ~110 MB file.
- Binaries fetched with Node's `fetch` get no quarantine attribute, so Gatekeeper does not block them.
- Global flags go before the subcommand and work for every command: `gitea --config X --work-path Y --custom-path Z web|admin …`.
- `gitea generate secret SECRET_KEY|INTERNAL_TOKEN|JWT_SECRET|LFS_JWT_SECRET` prints a fresh secret without any config. With
  `INSTALL_LOCK = true` and the secrets in app.ini, Gitea never needs to write to app.ini, so we can regenerate it on every start.
- `RUN_USER` must equal the OS user running Gitea (it refuses otherwise). Strip `GITEA*` env vars from its environment.
- `gitea admin user create …` works against a running instance (SQLite): same as `docker compose exec gitea gitea admin …`.
- Gitea keeps its own git home under `APP_DATA_PATH/home`, so the user's `~/.gitconfig` does not leak in.
- `[server] HTTP_ADDR = 127.0.0.1` binds loopback only (lsof shows `TCP 127.0.0.1:<port> (LISTEN)`).
- Detached start from Node: `spawn(bin, args, { detached: true, stdio: ['ignore', fd, fd] })` + `unref()`; the process survives the
  CLI and the MCP server. Start-up takes ~1 s on an M-series Mac.
- Port probing on macOS: a 0.0.0.0 listener (e.g. a Docker-published port) does not stop a 127.0.0.1 bind, so "bind succeeds" is not
  enough. Slipway also tries to connect; anything answering means taken.
- Docker env file: `GITEA____APP_NAME` (root section) and dotted sections (`GITEA__ui.meta__AUTHOR`) work with `env_file:` too.
- gitleaks release tarballs contain `gitleaks`, `LICENSE`, `README.md`; extract just the binary with `tar -xzf t.tgz -C dir gitleaks`.
- `claude plugin marketplace add <owner/repo> --sparse .claude-plugin plugin` clones only what the plugin needs. Re-adding an existing
  marketplace or reinstalling a plugin fails with "already…": use `marketplace update` / `plugin update` then.
