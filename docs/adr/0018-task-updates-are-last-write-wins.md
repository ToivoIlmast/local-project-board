# ADR-0018: Task updates are last-write-wins

Status: accepted (2026-09-21)

## Context

A person and an agent can edit the same task at the same time. Optimistic concurrency (`expectedUpdatedAt` → 409) would require the UI to show and resolve conflicts, for a collaborative scenario the MVP does not have.

## Decision

- `PATCH /api/v1/tasks/:id` and the other writes are last-write-wins.
- SSE shows changes made by an agent in the UI.

## Consequences

- No conflict UI.
- Optimistic concurrency can be added later without breaking the API: an optional precondition field is a compatible change.
