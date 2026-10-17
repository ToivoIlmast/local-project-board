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

## Amendment (T46, 2026-10-17, accepted with ADR-0030; implemented by T46)

The optional precondition foreseen above, for content only: `PATCH /tasks/:id` may carry
`ifContentHash`, the `contentHash` of the `title`, `body` and `labels` the client based its change
on. It is checked inside the per-task lock, in the same section as the write it guards, so two
saves based on the same content cannot both succeed. If the content hashes differently, the
answer is `409 TASK_CONTENT_CHANGED` and nothing is written. Without the field the update is
last-write-wins exactly as above. The page always sends it, with only the fields the person
changed; agents need not. Restore (`POST /tasks/:id/versions/:n/restore`) requires it. `status`,
`branch`, `workflow` and `aiRun` stay last-write-wins. A `PATCH` with `fromCheck` is checked in
the same section (ADR-0030 §7). Details in ADR-0030 §3–5.
