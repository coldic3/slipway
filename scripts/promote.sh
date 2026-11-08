#!/usr/bin/env sh
# promote.sh <repo> <pr-number> [--squash] [--draft] [--base <branch>] [--test-cmd "<cmd>"] [--as-me] [--force]
# Phase 0 entry point from the original product plan. Needs SLIPWAY_GITHUB_TOKEN in the environment.
# Exit codes: 0 ok, 1 error, 2 rebase conflict, 3 secrets/scan failure, 4 tests failed, 5 not approved.
set -eu
DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec "$DIR/bin/slipway" promote "$@"
