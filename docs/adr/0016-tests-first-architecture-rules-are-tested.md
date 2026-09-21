# ADR-0016: Tests first; architecture rules are tested

Status: accepted (2026-09-21)

## Context

Rules written only in prose drift silently.

## Decision

- New behavior starts with an invariant and a failing test.
- Jest covers unit, integration, API and storage conformance; `@playwright/test` covers real-browser end-to-end tests.
- Architecture rules are verified by linting deliberate violations in `test/lint/fixtures`.
- Every test layer names the defect, invariant or contract it protects.

## Consequences

- CI runs format check, lint, typecheck, tests and the package smoke test on the lowest supported Node and the current LTS.
