# 0003. Threat model: mistakes, not malice

Date: 2026-11-08 · Status: accepted

## Context
The agent, the plugin's MCP server and its hook all run as the developer's OS user, and `gh` is usually logged in. Containing an agent
that deliberately works around the tool would need a separate OS user or a container, and a much heavier setup.

## Decision
Slipway stops an agent that makes mistakes: it forgets the workflow, pushes or opens GitHub PRs by habit, or edits approved text. It
does not try to contain an agent that deliberately works around it. Concretely:
- promotion needs the reviewer's approval on the current head, and approved text is frozen for the agent (ADR 0006);
- the hook blocks pushes, GitHub PR writes and reading Slipway's credentials in registered repos (ADR 0009);
- tools never return secrets, and the GitHub token is never written to disk.
There is no environment sanitizing, no separate OS user and no keychain storage.

## Consequences
Simple setup: a default login and automatic enrollment of the agent's account (ADR 0005). Anyone who needs a real boundary must run
the agent as another OS user or in a container. The README says Slipway is a workflow tool, not a sandbox.
