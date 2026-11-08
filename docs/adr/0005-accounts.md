# 0005. Accounts: reviewer login, org-owned repos, technical admin

Date: 2026-11-08 · Status: accepted

## Context
The person reviewing should not be able to change repository settings or administer Gitea: a repo owner always has repo-admin
rights in Gitea and a site admin always has `/-/admin`. Setup should also need no choices: a local tool with a fixed, simple login.

## Decision
- **`admin`** is a technical Gitea admin with a random password stored only in `~/.slipway/config.json`. Only Slipway's tooling uses
  it (`setup`, `repo add`, `sync-main`, agent enrollment). Nobody signs in with it.
- **`slipway` / `slipway`** is the default reviewer login (`slipway setup --user/--password` changes it; re-running setup keeps a custom
  password). It is a plain user with write access to every review repo through the `reviewers` team: it can review, approve,
  request changes, resolve threads and edit titles and descriptions, but has no repo Settings and no site administration.
- Review repositories belong to the organization `repos`, managed by `admin`. Branch protection lets only `admin` push the base.
- Promotion counts only the reviewer's approval.
- No auto-login (a trusted-proxy login would let any local process act as the reviewer). Instead "Remember this device" lasts 365 days.
- Gitea's minimum password length is lowered to 6 and the pwned-password check is off (local, offline instance).

## Consequences
The default reviewer password is publicly known: any local process could sign in and approve. This is accepted under ADR 0003, and
`slipway setup --password …` restores a stronger setup. Site administration needs the `admin` password from the config, which is
deliberate friction. Re-running `setup` keeps valid tokens, the reviewer login and the enrolled agent.
