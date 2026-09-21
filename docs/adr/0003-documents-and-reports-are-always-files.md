# ADR-0003: Documents and reports are always files

Status: accepted (2026-09-21)

## Context

AI workflows produce Markdown and HTML. Keeping them as plain files is a product promise, not an implementation detail.

## Decision

- Documents are `.board/tasks/<id>/<name>.md|html`; reports are `.board/reports/<id>.html|md`.
- This holds for every storage provider: a database provider would store task metadata only.

## Consequences

- Exactly one source of truth per kind of data; no duplication between a database and files.
- A future networked provider would not share documents between machines (known trade-off).
