# ADR-0007: Git is read through the system git binary, read-only

Status: accepted (2026-09-21)

## Context

Git context is useful; writing to a user's repository from an HTTP request is a high-cost mistake.

## Decision

- A `GitReader` adapter calls `git` with `execFile` (never a shell string), `--` before paths, a timeout and an output limit.
- MVP operations: status, current branch, branches, recent commits, diff. No commit, push, checkout, merge or branch creation.

## Consequences

- No Git library dependency.
- Non-repositories, empty repositories, detached HEAD and worktrees must return valid answers.
