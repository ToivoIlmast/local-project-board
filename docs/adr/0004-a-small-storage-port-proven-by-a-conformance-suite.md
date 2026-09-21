# ADR-0004: A small Storage port, proven by a conformance suite

Status: accepted (2026-09-21)

## Context

Storage is selected by configuration, so it is a real boundary. An abstraction with one implementation is unproven.

## Decision

- One `Storage` interface in `core/ports.ts` (tasks, documents, reports). No query language, no transactions, no watch.
- One Jest conformance suite runs unchanged against every provider. An in-memory provider (tests only) is the second implementation from day one.

## Consequences

- Filtering, ranking and status rules live in core services, not in providers.
- A new provider is accepted when it passes the suite without changes to the suite.
