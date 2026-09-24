# ADR-0025: The page mirrors the board, without optimistic updates

Status: accepted (2026-09-23)

## Context

The board's page shows tasks, documents, reports and git context that the server owns. Two
things change them: this page, through the API, and someone else — an agent, an editor, a
second tab — whose changes arrive as events (§14). The usual answer for a React application
is a query cache (the proposal named TanStack Query) plus optimistic updates, so a card moves
under the cursor before the server has answered.

That answer costs more than it is worth here. The board is on loopback: an answer takes about
a millisecond. Ranking is deliberately the server's job (ADR-0011), so an optimistic card
position would be the page guessing at a fractional index the server has not computed yet —
the one thing the architecture set out to avoid. And a cache would be a second source of
truth next to the event stream, which already delivers the whole changed object.

## Decision

- Server state lives in one small store (`web/api/store.ts`): plain TypeScript, `subscribe` /
  `getState`, bound to React with `useSyncExternalStore`. No query library, no global state
  library, no store framework.
- The store changes in exactly two ways: the answer to a request this page made, and an event
  from the stream. Both go through the same pure reducer, `applyEvent`, which replaces by id —
  so the same change arriving twice leaves the board looking the same.
- There are **no optimistic updates**. A card moves when the board says it moved. While a
  change is in flight the card is marked busy; if the change fails, nothing has to be undone,
  because nothing was changed.
- `board.changed` — files edited outside the server — is not patched into the state: the page
  reads the board again. So does a reconnect, because the stream has no log.
- UI state (which panel is open, what is typed in a form) is not in this store. What the page
  is looking at lives in the address bar instead, so a reload lands where the user was.

## Amendment (2026-09-24, dogfooding)

A board that has been read once is not thrown away because a later read failed. The first
implementation set `phase: 'failed'` in every failed `load()`, so a re-read that failed — and
one is triggered by `board.changed`, which the board itself emits as it shuts down — replaced
the whole page with an error screen, losing the board the user was looking at. The page now
keeps the last state it was given, says that the board stopped answering, and offers to read it
again; only a board that was never read has nothing to show but the failure. The mirror may be
stale, and the page says so, but a stale mirror beats an empty wall.

## Consequences

- A move costs one request and shows the result the server computed; on a loopback board the
  difference from an optimistic update is not visible.
- There is no rollback code, no cache invalidation and no divergence between what the page
  shows and what the board contains.
- `applyEvent` keeps the objects of the tasks it did not touch, so a card that did not change
  does not re-render; that is what makes "one store for the whole board" cheap enough.
- If the board is ever reached over a slow link — sharing, §24 — this is the decision to
  revisit, and the place to revisit it is one reducer.
