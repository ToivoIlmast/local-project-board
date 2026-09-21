# ADR-0001: Board state lives in an untracked .board/ directory

Status: accepted (2026-09-21)

## Context

Tasks must not change when the developer switches branches, and all worktrees of a repository must see one board.

## Decision

- The board lives in `.board/` at the root of the main worktree, resolved as `dirname(git rev-parse --git-common-dir)`.
- `.board/` contains a `.gitignore` with `*`, so it ignores itself. We never modify the user's `.gitignore` or `.git/info/exclude`.
- Outside a Git repository, `.board/` is created in the current directory.

## Consequences

- `git checkout` never touches board state: `main`, `feature/F25` and every worktree share one board.
- The board is not part of `git clone` and is not backed up with the code; `board export` (ADR-0009) covers backup.
- `repo-tracked`, `git-branch` and `user-local` locations are possible future modes, resolved in one module.
