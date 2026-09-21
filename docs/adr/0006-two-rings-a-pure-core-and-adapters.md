# ADR-0006: Two rings: a pure core and adapters

Status: accepted (2026-09-21)

## Context

Frameworks and infrastructure are implementation details, but five named layers for five entities would be ceremony.

## Decision

- `src/core` holds the domain model, rules and services. It imports no Node APIs, no Express, no React and makes no network calls.
- Adapters (`src/server/*`, `src/web`) depend on core. Core declares exactly three ports: `Storage`, `GitReader`, `EventSink`.
- Dependency inversion is used only at those three boundaries.

## Consequences

- Core can run in a browser (future standalone mode) without changes.
- Replacing Express means rewriting `src/server/http` only.
- Enforced by ESLint and verified by `test/lint`. From phase 1, the core TypeScript project also has no Node or DOM types.
