# ADR-0017: No OpenAPI document in the MVP

Status: accepted (2026-09-21)

## Context

The UI takes its types from the contract directly, and agents use the generated instructions. Nothing in the MVP reads an OpenAPI document.

## Decision

- There is no `GET /api/v1/openapi.json` in the MVP.
- The contract remains the single source for validation, frontend types and AI instructions.

## Consequences

- One less endpoint and test to keep correct.
- The zod schemas can produce OpenAPI later with little work, when a real consumer appears (for example MCP or an external client).
