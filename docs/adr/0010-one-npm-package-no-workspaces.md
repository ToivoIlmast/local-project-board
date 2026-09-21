# ADR-0010: One npm package, no workspaces

Status: accepted (2026-09-21)

## Context

The tool is always installed as a whole with `npx`.

## Decision

- One package ships `bin/`, `dist/node` (core, contract, server) and `dist/web` (built SPA).
- Boundaries between parts are enforced by TypeScript projects and ESLint, not by separate packages.
- React and the UI toolchain are dev dependencies: users receive the built SPA.

## Consequences

- A package smoke test installs the packed tarball and starts it (`npm run test:pack`).
