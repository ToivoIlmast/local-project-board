# ADR-0008: Local security: loopback, Host/Origin checks, session token

Status: accepted (2026-09-21)

## Context

Any web page open in the browser can send requests to a localhost server.

## Decision

- The server binds to `127.0.0.1` only; there is no `--host` flag in the MVP.
- `Host` must be localhost/127.0.0.1 with our port (DNS rebinding); `Origin` must be absent or the board's own.
- A session token is generated at startup, stored only in `.board/runtime.json` (mode 600), and required for mutations.
- AI-generated HTML reports are shown in a sandboxed iframe with a CSP.

## Consequences

- A future shared board gets a separate, stricter security model. Local defaults are never loosened for sharing.
