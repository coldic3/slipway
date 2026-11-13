# 0015. Docker Sandboxes: Gitea stays on the host, the sandbox gets a copy of the config

Date: 2026-11-12 · Status: accepted

## Context
Claude Code can run inside a Docker Sandboxes (`sbx`) microVM. The sandbox mounts the project at the same path as on the host,
but it has its own `127.0.0.1`, its own home (`/home/agent`), no Node, no SSH agent, and network access only through sbx's proxy,
which allows hosts per policy and adds service logins such as GitHub without the token entering the sandbox. The plugin installed
there could not start (no `node`), could not find `~/.slipway/config.json`, and `127.0.0.1:<port>` did not reach Slipway.

## Decision
One Slipway per machine, on the host. A host command, `slipway sbx setup <name>`, wires an existing sandbox to it and can be re-run:
- **Network:** the sandbox reaches Gitea at `host.docker.internal:<port>`; sbx authorizes that as `localhost:<port>`, so the command
  adds that rule for the sandbox when policy does not already allow it, then checks `/api/healthz` from inside.
- **Config:** a copy of `config.json` is written to the sandbox's `~/.slipway` (through stdin, mode 600). `giteaUrl` points at
  `host.docker.internal`; `webUrl` keeps the address the user opens, and `sandbox` names the sandbox. The reviewer's password and
  token are left out: the sandbox never acts as the reviewer. The admin token stays, because mirroring the base branch needs it
  (ADR 0008); this is in line with ADR 0003. Gitea's data, `app.ini` and secrets are never visible in the sandbox. Links that Gitea
  returns use its `ROOT_URL` (`127.0.0.1`), so they open in the user's browser.
- **Runtime:** Node 22+ is installed with apt as root (`nodejs-24` on Docker's hardened Debian, plain `nodejs` as a fallback).
  The pinned gitleaks for the sandbox's CPU is downloaded and checked on the host and copied in, so promotion keeps failing closed
  (ADR 0007).
- **GitHub:** without an SSH agent in the sandbox, `git@github.com:` and `ssh://git@github.com/` are rewritten to HTTPS in the
  sandbox's global git config, so the proxy can add the login. In a sandbox, promotion adds no GitHub auth header of its own (the token
  `gh` reports there is a placeholder). The login comes from `sbx secret set github`. Slipway prints that command but never runs it. Promotion from a sandbox
  ships as experimental: it is not yet verified end to end that the proxy authenticates `git push` over HTTPS and the API calls.
- **Plugin:** installed or updated in the sandbox's Claude Code, as `slipway init` does on the host.
- **Plugin behaviour in a sandbox:** it never starts Gitea (there is no `instance.json`); it only checks that the host's Gitea is
  reachable. Its errors tell the user what to run on the host (`slipway sbx setup <name>`, `slipway repo add` and then `slipway sbx setup`).

A Gitea per sandbox was rejected: reviews would be scattered and lost with the sandbox. Mounting the host's `~/.slipway` was
rejected: it would expose Gitea's database and secrets, and it needs flags at sandbox creation. A plugin `userConfig` for the URL was
rejected: it would ask every user a question that only sandbox users need, and it would not provide the config, Node or the network rule.

## Consequences
After `slipway repo add` or a port change, the copy is stale until `slipway sbx setup <name>` runs again; the command and the plugin's
errors say so. Repos are matched by path, which works because sbx mounts workspaces at their host paths. The command depends on
`sbx` details (the `localhost:<port>` policy target, `sbx exec -u root`, `sbx ls --json`, the `secret ls` layout); they are unit-tested
against recorded behaviour and need a manual check when sbx changes. Cloud sandboxes (no host) are not supported.

Direction for later: no setup per sandbox. The plugin would ship as a standalone binary (no Node needed), fetched on first use and
checked like Gitea and gitleaks, and would configure itself in a sandbox (Gitea at `host.docker.internal`, its token held by the sbx
proxy). `slipway sbx setup` would then shrink to a check.
