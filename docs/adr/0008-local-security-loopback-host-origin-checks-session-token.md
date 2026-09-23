# ADR-0008: Local security: loopback, Host/Origin checks, session token

Status: accepted (2026-09-21)

## Context

Any web page open in the browser can send requests to a localhost server.

## Decision

- The server binds to `127.0.0.1` only; there is no `--host` flag in the MVP.
- `Host` must be localhost/127.0.0.1 with our port (DNS rebinding); `Origin` must be absent or the board's own.
- A session token is generated at startup, stored only in `.board/runtime.json` (mode 600), and required for mutations.
- AI-generated HTML reports are shown in a sandboxed iframe with a CSP.

## Amendment (2026-09-23, owner's decision, implemented in phase 9)

How the token reaches a client is settled here rather than in a new ADR, because it changes
nothing about the model above:

- The token is never written into HTML. The board's own page asks for it: `GET /api/v1/session`
  answers `{ "token": "..." }` over the same origin, so `APP_CSP` stays strict (`script-src 'self'`,
  no inline script, no nonce).
- `GET /api/v1/instructions` needs no token and contains one: handing the instructions to an agent
  is the point of the route. A foreign page cannot read either answer — its `Origin` is refused and
  no CORS header is ever sent — and both routes are under the same Host/Origin checks as the rest.
- Those two routes are the only ones that ever answer with the token, it is never read from a URL,
  and it is never logged.

## Consequences

- A future shared board gets a separate, stricter security model. Local defaults are never loosened for sharing.
