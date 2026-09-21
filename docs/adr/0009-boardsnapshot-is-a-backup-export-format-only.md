# ADR-0009: BoardSnapshot is a backup/export format only

Status: accepted (2026-09-21)

## Context

`.board/` is untracked, so it needs a simple backup and export path.

## Decision

- `board export` writes a single JSON `BoardSnapshot` (tasks, documents, reports, `formatVersion: 1`).
- It is not a persistence model and not a basis for sync, merge, conflict resolution or collaborative editing.
- `board import` is future work.

## Consequences

- The source of truth stays `.board/` + files.
- Future migration between providers and a standalone board can reuse the format.
