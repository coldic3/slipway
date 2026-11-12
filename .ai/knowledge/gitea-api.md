# Gitea API knowledge (verified against gitea/gitea:28.3.0-rootless)

- Docker Hub versioning jumped from `1.27.x` to `28.x` (Nov 2026 tags: `28.3.0`, `28.3.0-rootless`, `1.27.3`).
- Swagger: `GET /swagger.v1.json` on a running instance (useful for checking field names).
- Review comment threads: `POST /repos/{o}/{r}/pulls/{index}/comments/{id}/replies` body `{body}` → 201 PullReviewComment.
- Resolve: `POST /repos/{o}/{r}/pulls/comments/{id}/resolve` (and `/unresolve`) → 204.
- `PullReviewComment.resolver` is null while unresolved.
- Review comments: `GET /pulls/{index}/reviews`, then `GET /pulls/{index}/reviews/{id}/comments`.
- Branch protection (`CreateBranchProtectionOption`) has `block_admin_merge_override`, `enable_merge_whitelist`,
  `merge_whitelist_usernames`, `enable_push_whitelist`, `push_whitelist_usernames`, `enable_force_push_allowlist`,
  `force_push_allowlist_usernames`, `rule_name`, `priority`.
- `EditRepoOption` merge toggles: `allow_merge_commits`, `allow_rebase`, `allow_rebase_explicit`, `allow_squash_merge`,
  `allow_fast_forward_only_merge`, `allow_manual_merge`.
- Fresh instance without the install wizard: env `GITEA__security__INSTALL_LOCK=true`, `GITEA__database__DB_TYPE=sqlite3`.
  `/api/v1/version` answers within ~5 s of container start.

## Gitea 28 config changes
- `[webhook] ALLOWED_HOST_LIST` is deprecated (and planned for removal) → use `[security] ALLOWED_HOST_LIST`
  (env `GITEA__security__ALLOWED_HOST_LIST`).
- Rootless image: `docker compose exec -T gitea gitea admin user create --username U --password P --email E [--admin] --must-change-password=false`
  works without `--config`. A second create fails with `user already exists`; `gitea admin user change-password` keeps the password in sync.
- The healthcheck endpoint is `/api/healthz`; `docker compose up -d --wait` takes about 5–10 s.
- With `REQUIRE_SIGNIN_VIEW=true`, anonymous `/api/v1/version` returns 403; use `/api/healthz` for readiness.
- Password policy: Gitea's default `MIN_PASSWORD_LENGTH` is 8. For the 7-char default `slipway` we set `GITEA__security__MIN_PASSWORD_LENGTH=6`
  and `PASSWORD_CHECK_PWN=false`.

## Users, orgs and permissions (verified 2026-11-07)
- `admin` is an allowed Gitea username (not reserved).
- User and org names share one case-insensitive namespace: org `Slipway` fails with "user already exists" while user `slipway` exists.
- Repo owner = repo admin: always sees Settings. A **write** collaborator gets no Settings tab and `/settings` returns 404, but can
  review/approve, resolve threads and edit PR title/body. Non-site-admins get 404 on `/-/admin`.
- Org repo: `POST /orgs/{org}/repos`. Org: `POST /orgs {username, visibility}`.
  Transfer: `POST /repos/{owner}/{repo}/transfer {new_owner}`; as site admin it is immediate and keeps PRs, reviews and comments.
- Demote a user: `PATCH /admin/users/{u}` `{login_name: u, source_id: 0, admin: false}`.
- Teams API (Gitea 28): send either `units` or `units_map`, not both (400 "only one of units or units_map can be set").

## PR base changes, timeline, closing (verified on 28.3.0, 2026-11-12)
- Retarget: `PATCH /repos/{o}/{r}/pulls/{n}` `{base}`. Missing base → 404 `new base '<b>' not exist`. Gitea accepts base == head
  (validate it yourself).
- A base change does **not** dismiss or mark stale an existing approval (`dismissed: false`, `stale: false`).
- `GET /repos/{o}/{r}/issues/{n}/timeline` (chronological): `change_target_branch` (`old_ref`, `new_ref`), `review` (`review_id`),
  `pull_push` (body JSON `{is_force_push, commit_ids}`), `comment`, `close`, `reopen`. Written for API and UI changes alike.
  `created_at` has second precision.
- Close: `PATCH …/pulls/{n}` `{state: "closed"}`; reopen with `{state: "open"}`.
- `GET …/pulls/{n}/commits?stat=false&files=false` and `GET …/pulls/{n}/files` (filename, status, additions, deletions).
