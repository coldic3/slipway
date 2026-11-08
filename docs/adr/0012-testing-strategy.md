# 0012. Testing strategy

Date: 2026-11-08 · Status: accepted

## Decision
- `tests/unit` (Vitest): pure logic, no network, no Gitea.
- `tests/functional` (Vitest): real git on temporary repositories (promotion engine, push leases, conventions, gitleaks wrapper),
  the packed file list, the bundled CLI and plugin.
- `tests/e2e` (Playwright): global setup starts an isolated Slipway with `slipway init` (native runtime on port 3300,
  `SLIPWAY_E2E_RUNTIME=docker` for Docker) against a mock GitHub API and a fake `gh`. Tests drive the bundled MCP server as the agent
  and Chromium for the reviewer.
- CI (`.github/workflows/ci.yml`) runs unit and functional tests and the e2e suite on both runtimes.

## Consequences
Everything that matters runs against a real Gitea and real git, without touching GitHub. E2E shares one stack (`workers: 1`).
