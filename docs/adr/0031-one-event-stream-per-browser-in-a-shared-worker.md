# ADR-0031: One event stream per browser, held by a SharedWorker

Status: accepted (2026-10-28, T62)

## Context

Every tab of the board opened its own `GET /api/v1/events` (§14). The stream never ends, and
after a break the browser comes back in three seconds. Chromium keeps at most six HTTP/1.1
connections per host:port and shares them between all of its tabs. With six tabs open all six
were held by streams, and every other request of every tab — the board, the documents, the
history, even `/` itself — waited in the browser's queue for ever: pending, 0 bytes, never sent.
The server was healthy throughout. `fetch` had no deadline, so nothing failed either: the page
showed `Loading…` until it was closed. `server.open: true` opens a new tab on every start, so
tabs piled up across restarts, and a restart did not help: within three seconds every tab had
its stream back.

The number of long-lived connections a browser holds to the board must therefore not grow with
its tabs, with every tab visible at the same time.

## Options

- **A SharedWorker holds the one stream and relays it to the tabs.** One connection per browser
  by construction; the worker lives while any tab of the board is open, so closing a tab — any
  tab, also the first — changes nothing for the others, and there is no leader to hand over.
  Costs a second, tiny bundle (under 1 kB) and a message protocol. Not available in Chrome on
  Android; other browsers have it.
- **A leader tab, elected with Web Locks, relays over BroadcastChannel.** One connection per
  browser too, no worker. But the leader can be closed, frozen or throttled like any tab, and
  between the old leader leaving and the new one connecting events are lost, so every tab must
  resync on every hand-over. More moving parts (election, hand-over, resync) for the same
  result.
- **HTTP/2.** Multiplexes all streams over one connection and lifts the limit to ~100 streams.
  Browsers speak HTTP/2 only over TLS; the board is plain `http://127.0.0.1` and would need a
  certificate the browser trusts. Not practical.
- **Polling instead of a stream.** No long-lived connection at all, but every tab asks every
  few seconds for ever, and updates arrive late. It throws away §14 for a browser limit.
- **Short-lived streams (close after a while, or long polling).** Reduces how long a connection
  is held, not how many: seven tabs still each hold one most of the time.
- **Closing the stream in hidden tabs.** Helps only while tabs are hidden; seven visible tabs
  (several windows side by side) still exhaust the pool. At most an addition.

## Decision

- The page subscribes through `subscribeToSharedBoard` (`web/api/sharedEvents.ts`). It connects
  to the SharedWorker `web/api/events.worker.ts`, whose logic is `createEventHub`
  (`web/api/eventHub.ts`): the first tab's `hello` opens the stream, every later tab is counted
  in and told the current status, frames are relayed as they came (each tab still checks them
  against the contract), and the last tab's `bye` closes it.
- When the worker's stream comes back after a break, the hub tells **every** tab to resync, and
  each one reads the board again with `store.load()` — the board, and the documents, history
  and checks of what it has open. A tab that returns from the back/forward cache resyncs too. A
  server restart is such a break: the same origin, the same worker, a new stream; the client
  fetches the new token on its next change, as before.
- Where there is no SharedWorker, the worker cannot start, or it has no `EventSource`, the tab
  falls back to a stream of its own (`subscribeToBoard`), as before T62.
- Every request of `BoardClient` has a deadline (`DEFAULT_TIMEOUT_MS`, 30 s; per client and per
  call), and a caller may pass its own `AbortSignal`. A deadline fails with `TIMEOUT`, a
  caller's abort with `ABORTED`; neither leaves a timer or a listener behind. A request that
  cannot be sent now ends in an error the page already shows, with its retry, never in an
  endless spinner.

## Consequences

- One browser holds one stream to the board, however many tabs it has; the seventh tab works.
  `test/e2e/tabs.spec.ts` opens seven tabs and fails on the stream-per-tab page.
- The worker's script has a hash in its name. After an upgrade of the board, tabs of the old
  build keep their old worker and a new tab starts a new one: one stream per build, not per
  tab.
- The browser fallback costs a connection per tab again, which is the old behaviour; the
  deadline still keeps such a page from hanging silently.
- A tab that crashes without saying `bye` stays counted until the worker ends; posting to its
  port does nothing, and the worker ends with the last tab of the board.
