# ADR-0011: Card position is a fractional index computed by the server

Status: accepted (2026-09-21)

## Context

Moving a card must not rewrite every task file in a column, and clients must not duplicate ranking logic.

## Decision

- Each task has a string `rank` (fractional index). `POST /api/v1/tasks/:id/move {status, before?, after?}` computes it on the server.

## Consequences

- A move writes one file. The UI and AI agents describe moves by neighbours, not by rank values.
