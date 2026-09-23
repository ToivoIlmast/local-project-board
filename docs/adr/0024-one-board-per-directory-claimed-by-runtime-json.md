# ADR-0024: One board per directory, claimed by runtime.json

Status: accepted (2026-09-23)

## Context

A board is a directory (`.board/`) and a server in front of it. Two servers on one directory
would allocate ids from the same sequence and answer with two different session tokens. The
board is a personal tool, so the answer must be simple: one running board per directory, and a
way to tell whether one is running.

## Decision

- A running board writes `.board/runtime.json`: `{ formatVersion, pid, port, url, token, root }`,
  mode 600, written through a temporary file and a rename, removed on shutdown.
- It is written **after** the server is listening and never before, so it cannot describe a
  board that does not exist.
- Whether the board it describes is still running is decided by asking that board:
  `GET /api/v1/project` must answer and name the same board root. A pid can be reused and a
  port can be taken over by something else; an answer from the board itself cannot.
- A runtime file whose board no longer answers is stale: the new run replaces it silently.
- A runtime file that cannot be parsed stops the start with a message naming the file. The
  board cannot tell whether one is running, and a second server on one `.board/` is worse than
  a refusal to start.
- No lock files, no leases, no cross-process coordination beyond this.

## Consequences

- The check costs one loopback request on startup, and nothing at all when no board ran before.
- A user who kills the board keeps a stale file, which the next start clears up by itself.
- The token lives in exactly two places on disk and in neither of them for long: this file,
  which is removed on exit, and nowhere else (ADR-0008).
- If a board is ever allowed to serve several directories, or a directory to host several
  boards, this ADR is what has to change.
