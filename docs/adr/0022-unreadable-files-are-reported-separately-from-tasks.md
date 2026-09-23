# ADR-0022: Unreadable files are reported separately from tasks

Status: accepted (2026-09-23)

## Context

People and AI agents edit task files directly, so a file can stop matching the schema: broken YAML, a missing field, an invalid rank. The board must not crash, and it must not quietly drop the file either — a card that vanishes looks exactly like a card someone deleted. That is misleading for a person and worse for an agent, which would conclude the task no longer exists.

Representing such a file as a `Task` would mean inventing a `status`, a `rank` and a `title` that nobody wrote.

## Decision

- A file that does not fit the schema is never turned into a `Task`.
- `Storage.readIssues()` returns what could not be read: `{ file, message }`, with `file` relative to the board directory (`tasks/T7/task.md`). A file that gets fixed stops being reported; nothing is cached.
- `GET /api/v1/project` carries that list as `readIssues`. The UI shows it as a plain notice ("2 files could not be read") next to the board.
- The name is `readIssues`, not `issues`: on a board, "issue" reads as a task.
- No issue types, codes or severities. One shape, one message.

## Consequences

- The valid tasks keep working while a broken file is being fixed.
- An agent can tell "unreadable" from "deleted" through the API.
- An in-memory provider reports an empty list: it cannot hold an unreadable task.
