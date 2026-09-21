# ADR-0005: The API contract is a zod route table

Status: accepted (2026-09-21)

## Context

Validation, frontend types and the instructions given to AI agents must not drift apart.

## Decision

- `contract/v1/routes.ts` lists every route once: method, path, request/response schemas, an example and `ai` metadata.
- Runtime validation, frontend types and the generated Claude Instructions all come from it.

## Consequences

- A test fails when a route marked `ai.include` is missing from the generated instructions.
- The route table stays a plain array of objects; no build-time code generation.
