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

## Amendment (2026-10-29, owner's decision, T70)

The amendment of 2026-09-23 is changed in one place: `GET /api/v1/instructions` no longer contains
the token. The instructions were copied into chats and their transcripts, and during the dogfooding
of T40 the token leaked three times: into a file in a scratchpad, eleven times into a transcript
as a literal in commands, and with the instructions themselves.

- `GET /api/v1/session` is the only route that answers with the token. The instructions, the
  output of `npx local-project-board instructions` (with the board running or not) and the panel
  «AI instructions» carry the placeholder `<session token>` and say where to get it. The generator
  has no parameter for a token, so it cannot embed one.
- An agent keeps the token nowhere: it is not printed (the answer of `GET /session` included), not
  written to any file (scratchpad and temporary files included), not put into a task, a document, a
  report or a URL, and not typed into a command as a literal. It is taken into a shell variable in
  the same command that needs it, because the shell keeps no state between tool calls.
- It stays out of the argv of child processes too: `curl -H "Authorization: Bearer $TOKEN"` expands
  the variable into the argv of `curl`, which `/proc/<pid>/cmdline` shows to the whole machine. The
  header goes through stdin: `printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -H @- ...`.
  This was checked, not assumed (curl 8.5.0, bash 5): `printf` is a builtin, so no process of its
  own with the token in its argv exists; `curl -H @-` reads the header from stdin and the server
  received it; scanning `/proc/*/cmdline` while the request was in flight found no match, and found
  `curl` with the literal in its argv in the control run.
- The rule is one constant, `TOKEN_RULE` in `src/contract/v1/tokenRule.ts`, used by the
  instructions, the handoff of a task and the handoff of a check or a research.

The rest is unchanged: the token is never read from a URL, never logged, and a foreign page cannot
read the answer of `GET /session`.

## Consequences

- A future shared board gets a separate, stricter security model. Local defaults are never loosened for sharing.
