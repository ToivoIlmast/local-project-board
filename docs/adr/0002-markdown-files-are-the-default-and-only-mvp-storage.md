# ADR-0002: Markdown files are the default and only MVP storage

Status: accepted (2026-09-21)

## Context

The board must be readable by humans and AI agents without the server, with zero setup and no native dependencies.

## Decision

- Tasks are `.board/tasks/<id>/task.md` (YAML frontmatter + Markdown body).
- It is the default provider and the only one implemented in the MVP.

## Consequences

- No database, no migrations, no native modules; `grep`, `cat` and any editor work.
- SQLite, PostgreSQL and MySQL remain possible providers behind the `Storage` port (ADR-0004).
