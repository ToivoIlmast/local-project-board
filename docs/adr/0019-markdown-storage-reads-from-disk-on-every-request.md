# ADR-0019: Markdown storage reads from disk on every request

Status: accepted (2026-09-21)

## Context

Agents may edit board files directly. An in-memory index kept fresh by `fs.watch` would serve stale data whenever the watcher misses an event, and on WSL2 the watcher does not work at all for `/mnt/c` paths.

## Decision

- The Markdown storage has no in-memory index or cache. Every read goes to the filesystem.
- `fs.watch` is used only to push live updates to the UI over SSE. Data correctness never depends on it.

## Consequences

- `GET /api/v1/tasks` reads every `task.md`; for hundreds of tasks this is milliseconds.
- A cache is added only if profiling shows a need.
- Duplicate events (own write + watcher) are harmless.
