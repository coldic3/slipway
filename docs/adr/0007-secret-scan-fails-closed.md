# 0007. Secret scan fails closed

Date: 2026-11-08 · Status: accepted

## Decision
Promotion runs `gitleaks git --log-opts=<base>..HEAD` on the reviewed commits. gitleaks is taken from PATH, then from the pinned,
checksum-verified download in `~/.slipway/bin`, then from its Docker image. A finding, any error or a missing scanner blocks the
push, with a PR comment that names the rule, file and line but never the secret. There is no option to skip the scan.

## Consequences
Promotion always has a secret scan. `slipway up` downloads gitleaks when it is missing; Homebrew installs it as a dependency.
