# ADR-0020: Task ids are monotonic and never reused

Status: accepted (2026-09-23)

## Context

A task id appears in documents, reports, AI instructions, links between tasks, exports and logs. If `T3` can mean one task today and a different one after a deletion, every such reference becomes ambiguous — including data that has already left the board.

Deriving the next id from `max(existing ids) + 1` reuses the id of the highest task as soon as it is deleted.

## Decision

- **INVARIANT: once an id has been allocated, that id is never allocated again for the same board.**
- The board stores a monotonic `sequence`: the number of ids it has ever handed out. Allocation is `sequence + 1`, and deleting a task never lowers it.
- The policy is one pure function in `core/rules/ids.ts` (`allocateId`), so every storage provider behaves the same way. A provider only persists the number.
- `allocateId` also takes the existing ids and continues from `max(sequence, highest existing id)`. That covers a hand-edited board and a future `board import`, where the stored number can be behind.
- Providers allocate atomically: the read of the sequence, the write of the task and the write of the new sequence happen without interleaving another create.
- No UUIDs, no id service, no separate abstraction. `T1`, `T2`, `T3` stay readable for humans and agents.

## Consequences

- The Markdown provider keeps the sequence in a small file in `.board/`, written with the same temp+rename as everything else.
- Ids have gaps. That is the point: a gap is visible evidence that a task was deleted.
- The storage conformance suite gains an invariant: create three, delete the highest, create again → a new id; and the sequence survives reopening the board.
