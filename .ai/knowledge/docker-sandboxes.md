# Docker Sandboxes (sbx) facts (sbx v0.53.0, verified 2026-11-12)

- `sbx` is the CLI (`brew install`); docs: https://docs.docker.com/ai/sandboxes/. The `claude` agent runs as `agent` (uid 1000,
  sudo) in a Debian-based "Docker Hardened Image", HOME `/home/agent`; workspaces are mounted at their host paths.
- No `node` in the claude image. `apt-get install nodejs-24` (also `nodejs-22`; plain `nodejs` is 20) works as root via
  `sbx exec -u root <name> …` and survives restarts. No `hostname` binary (Node's `os.hostname()` works).
- The sandbox's 127.0.0.1 is its own. The host is `host.docker.internal`; policy authorizes it as `localhost:<port>`:
  `sbx policy check network --sandbox <name> localhost:<port>` (exit 0 = allowed), `sbx policy allow network --sandbox <name> localhost:<port>`.
- `sbx exec <name> …` starts a stopped sandbox; exit 125 = no such sandbox. `sbx exec -i` passes stdin. `sbx cp host <name>:/abs`
  keeps the host uid/mode (chown as root afterwards). `sbx ls --json` → `[{name, workspaces[], mounts[], status}]`.
- `sbx secret ls` columns: SCOPE TYPE NAME SECRET (`(global)` or the sandbox). GitHub login for the proxy:
  `sbx secret set github [--sandbox <name>] --command 'gh auth token'`. Without it `GH_TOKEN` is still set to a placeholder and
  `gh api` gives "Bad credentials".
- No SSH agent by default (`SSH_AUTH_SOCK` empty, no `~/.ssh`): SSH GitHub remotes fail; HTTPS to github.com works (public repos
  without a secret). `git remote get-url` shows the insteadOf-rewritten URL.
- Env for every session: `/etc/sandbox-persistent.sh` (`CLAUDE_ENV_FILE`/`BASH_ENV`). Sandboxes set `SANDBOX_NAME` and `IS_SANDBOX=1`.
- Kits (`--kit`, YAML mixins) can't be added to an existing v3 sandbox, so Slipway prepares sandboxes with `sbx exec` instead.
