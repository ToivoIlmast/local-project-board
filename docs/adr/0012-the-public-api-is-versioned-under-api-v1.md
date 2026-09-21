# ADR-0012: The public API is versioned under /api/v1

Status: accepted (2026-09-21)

## Context

AI agents and scripts will depend on the API.

## Decision

- All endpoints live under `/api/v1`. A future `/api/v2` would be a second contract and HTTP layer over the same core.

## Consequences

- The version is a path prefix, not infrastructure.
