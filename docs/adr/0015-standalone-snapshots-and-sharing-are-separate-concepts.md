# ADR-0015: Standalone snapshots and sharing are separate concepts

Status: accepted (2026-09-21)

## Context

Showing the board to someone else can mean a file or network access to a live board.

## Decision

- A standalone board is a portable snapshot file (future: `board.html` + IndexedDB).
- Sharing is network access to a live board (future: LAN, tunnels, plugins) with its own security model.
- They do not share a domain abstraction.

## Consequences

- Neither is implemented in the MVP. Core purity (ADR-0006) and `BoardSnapshot` (ADR-0009) keep standalone possible.
