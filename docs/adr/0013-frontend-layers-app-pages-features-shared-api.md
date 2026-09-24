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

## Amendment (2026-09-23, implemented in phase 11)

- A **page** may import `api/` as well as features and shared. A page is where the board's
  state meets its layout; handing every field and every action to it as a prop from `app/`
  would be ceremony, not a boundary. It still knows nothing of the server beyond the client.
- `api/` may not import `shared/ui`: the API layer answers with data, never with markup. Both
  rules are ESLint policies with fixtures in `test/lint`.
- The React binding of the API layer is one file (`api/react.tsx`); the client, the store and
  the event subscription are plain TypeScript, so replacing React means rewriting that file.
