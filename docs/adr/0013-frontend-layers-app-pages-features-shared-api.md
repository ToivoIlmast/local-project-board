# ADR-0013: Frontend layers: app, pages, features, shared, api

Status: accepted (2026-09-21)

## Context

We want modular features without layers created for their own sake.

## Decision

- `app/` (bootstrap, providers, routing), `pages/` (real routes), `features/` (user-facing functionality, flat when small), `shared/` (primitives without domain knowledge), `api/` (the single client for the server).
- Features expose a minimal public API via `index.ts` (or are a single file). No deep imports between features.
- `widgets/` appears only when one composition of two or more features is needed on two or more pages. No `entities/`: domain types come from the contract.
- The UI toolkit is hidden behind `shared/ui`.

## Consequences

- Enforced by ESLint (`eslint-plugin-boundaries`, `no-restricted-imports`); verified by `test/lint`.
