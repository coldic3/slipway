# Gitea 28.3 UI selectors (verified with Playwright against a live instance)

- Login `/user/login`: `getByLabel(/Username or Email/i)`, `getByLabel(/Password/i)`, `getByRole('button', {name: /Sign In/i})`.
- Files tab `/<owner>/<repo>/pulls/<n>/files`:
  - A diff row: `tr:has(td.lines-num-new[data-line-num="<N>"])`. The "+" button is `button.add-code-comment-right`; it is
    `tw-invisible` until hover, so call `row.hover()` first (getByRole cannot find it while invisible).
  - The inline form appears in `tr.add-comment`; pick it with `page.locator('tr.add-comment form', { has: page.locator('textarea[name="content"]:visible') })`.
    It does NOT have the `comment-form` class (the hidden template forms do).
  - Buttons: "Start review" (`name=pending_review`), "Add single comment" (`name=single_review`).
  - Header button `getByRole('button', { name: /^Review/ })` opens the panel: textarea placeholder "Review comment",
    buttons "Approve" (`type=approve`), "Comment" (`type=comment`), "Request changes" (`type=reject`).
- Conversation tab: new-comment form `#comment-form textarea[name="content"]` + button "Comment";
  thread button "Resolve conversation".
- A line that already has a conversation shows the thread under the row instead of a fresh form; use a clean line in tests.
- Remember-me cookie is `gitea_incredible`; its lifetime is `[security] LOGIN_REMEMBER_DAYS` (default 31). The login page checkbox label is "Remember this device".
