# Architecture

How the code is laid out today and where new code goes. The reasons behind each choice are in
the [ADRs](adr/README.md); this page links to them instead of repeating them. The route
reference is [api.md](api.md), generated from the route table.

## Two rings

```text
   src/server/cli ──► src/server/http ──► src/contract ──► src/core
        │                                                     ▲
        └────────────► src/server/{storage,git,events,…} ─────┘

   src/web/*  ──► src/contract  (types and schemas only)
```

- **Inner ring: `src/core` and `src/contract`.** Pure TypeScript. No Node APIs, no Express,
  no React, no `fetch`, no `process`, no browser globals. `tsconfig.core.json` compiles both
  with `types: []` and `lib: ES2023`, so a Node or DOM type does not even resolve.
- **Outer ring: adapters.** `src/server/*` and `src/web`. They depend on the inner ring; the
  inner ring never depends on them.
- **Dependency inversion is used only at the three ports** in
  [ports.ts](../src/core/ports.ts): `Storage`, `GitReader` and `EventSink`. Everything else
  is a plain import. See ADR-0006.

`core` holds the model (`model/`), the pure rules (`rules/`: ids, statuses, ranks, document
names, AI rules, workflow settings, the history of a task) and the services (`services/`) that
implement the use cases on top of the ports. `contract/v1` holds the zod route table, the request and response schemas,
and what is generated from them: [api.md](api.md) and the AI instructions (ADR-0005, ADR-0012).

## The server

| Directory                                 | Role                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/server/storage`                      | Implements `Storage`; the markdown adapter (ADR-0002/0004)                                       |
| `src/server/git`                          | Implements `GitReader` over the system `git` (ADR-0007)                                          |
| `src/server/events`                       | Implements `EventSink`; in-process bus for the SSE stream                                        |
| `src/server/config`, `src/server/project` | Configuration and board-root discovery (ADR-0021/0024)                                           |
| `src/server/http`                         | Express: routes, errors, security, SSE, the runners waiting for Send to AI                       |
| `src/server/cli`                          | Arguments, the composition root, listening, `runtime.json`, `claude <ID>`, `--wait`, `--recover` |

`src/server/cli/serve.ts` is the only place where the pieces are put together: it creates the
event bus and the storage, builds the services, and hands `http` a `BoardContext`. A route can
therefore do only what a service already offers, and a service never learns that there is a
token. Security is in `http/security.ts` (ADR-0008).

No module of the server starts a process for a request. Send to AI → Claude Code reaches a
process only through a runner the person started (`claude --wait`): `http/runs.ts` hands a task
id to one waiting runner, and `cli/claudeWait.ts` starts the session with `cli/claude.ts`, the
same way `claude <ID>` does (ADR-0029, amended by T27). Nor does any module of the server look at
a process: whether a run whose runner died is still alive is read from `/proc` by
`cli/recover.ts` (`claude --recover <ID>`), with the runner's journal of `cli/runJournal.ts`, and
the board is only told the verdict (ADR-0029, amended by T45).

## The history of a task

Every task has a history beside it (ADR-0030, T46): **versions** of its content (`title`, `body`
and `labels`, nothing else) and **actuality checks**, an agent's comparison of the task with the
repository. Both are append-only: a record is created once and never rewritten or removed, except
together with the task.

- **Where.** `.board/tasks/<id>/history/versions/<n>.json` and
  `.board/tasks/<id>/history/checks/<n>.{begin,report,end}.json` with `<n>.decisions/<k>.json`.
  `Storage` has methods that add and read (`appendVersion`, `beginCheck`, `writeCheckReport`,
  `endCheck`, `appendDecision`, …) and none that change or delete, so no route can. The markdown
  adapter creates each file with `wx` (`server/storage/markdown/history.ts`); a file it cannot
  read is a read issue, left out of the lists and counted when numbering.
- **When a version is made.** Inside one locked section per task (`core/services/taskLocks.ts`,
  shared by the services and taken once per request): read, every precondition
  (`ifContentHash`, then `fromCheck`, then the existing rules), sync (`baseline` for a task with
  no history, `external` for a change made outside the server), write `task.md`, append the
  version (`core/services/tasks.ts`, `taskHistory.ts`). Equal content makes no version, and
  neither does a move or a change of status, branch or workflow. `GET` writes nothing.
- **The check.** Started like a run (`POST /tasks/:id/run` with `kind: 'check'`, handled by the
  waiting runner, `claude <ID> --check`) but recorded apart from `aiRun`: begin, report and end
  routes of `core/services/history.ts`, a handoff that holds the snapshot of the pinned version
  (`contract/v1/checkHandoff.ts`), and a runner journal of its own,
  `.board/runner/<ID>-check-<n>.json` (`cli/checkJournal.ts`, `checkEnd.ts`, `checkSession.ts`),
  which the journals, the delivery of ends and `claude --recover` of work runs never read. The
  process is spawned by `cli/spawnSession.ts`, shared with `claude <ID>`.
- **Pure functions** in `core/rules/history.ts`, re-exported by `contract/v1/history.ts` so that
  the page runs the very ones the server does: `contentHash`, `diffContent`, `diffLines` and
  `applyRecommendations`.
- **On the page** (`web/features/tasks`): the version select and the historical view in
  `TaskDetails`, the versions and their comparison, the checks and a report with a decision per
  recommendation, and an edit that shows a diff before it saves. Applying a recommendation is the
  ordinary editor with a draft; the save sends only the changed fields, `ifContentHash` and
  `fromCheck`, and a refusal (409) keeps the draft.

## The contract between the server and the page

`src/contract/v1` is the single description of the wire format. The server registers its
routes from the route table; the page's client (`src/web/api/client.ts`) takes its types and
schemas from the same place, so the two cannot drift. Both may import `contract`; the
contract imports only `core` and itself.

## The page: `src/web`

| Layer              | Holds                                                                         |
| ------------------ | ----------------------------------------------------------------------------- |
| `app/`             | Bootstrap, providers, the top-level composition                               |
| `pages/`           | Real routes: where the board's state meets a layout                           |
| `features/<name>/` | User-facing functionality; another feature is reached only through `index.ts` |
| `shared/`          | Primitives with no domain knowledge; the UI toolkit hides behind `shared/ui`  |
| `api/`             | The single client for the server: client, store, events, one React binding    |

`@/` is an alias for `src/web/`. A single-file feature (`features/instructions.tsx`) is its
own public API. The page mirrors the board and does not update optimistically (ADR-0025).
See ADR-0013 for the layering.

## Where the boundaries are, and how they are checked

The boundaries are the `elements` and `dependencyPolicies` in
[eslint.config.js](../eslint.config.js), enforced by `eslint-plugin-boundaries` with
`default: 'disallow'`: an import that no policy allows is an error. Each element may import:

| Element               | May import                                                            |
| --------------------- | --------------------------------------------------------------------- |
| `core`                | `core`                                                                |
| `contract`            | `core`, `contract`                                                    |
| `server/<adapter>`    | `core`, other adapters                                                |
| `server/http`         | `core`, `contract`                                                    |
| `server/cli`          | `core`, `contract`, `http`, adapters                                  |
| `web/app`             | `pages`, `features`, `shared`, `api`                                  |
| `web/pages`           | `pages`, `features`, `shared`, `api`                                  |
| `web/api`             | `api`, `contract`, `shared`                                           |
| `web/shared`          | `shared`                                                              |
| `web/features/<name>` | `api`, `shared`, `contract`, itself, and another feature's `index.ts` |

Beyond the graph, ESLint also forbids:

- Node built-ins, Express, React and React DOM in `core` and `contract`; the globals `fetch`,
  `process`, `document`, `window`, `localStorage`, `sessionStorage` and `navigator` there too;
- Express anywhere in `src/server` outside `http`;
- `web/api` importing `shared/ui`: the API layer answers with data, never with markup;
- `@/features/*/*` deep imports in `web`, and `fetch` in `web` outside `web/api` and
  `shared/lib/http*`: the page talks to the server only through `BoardClient`.

Lint rules that nobody tests drift, so [test/lint/boundaries.test.ts](../test/lint/boundaries.test.ts)
lints the deliberate violations and deliberate allowed imports in `test/lint/fixtures/src`
and fails if the config stops rejecting one or starts rejecting the other (ADR-0016).
`npm run lint` runs the rules over `src`.

## Where new code goes

| You are adding…                               | Put it in                                                          |
| --------------------------------------------- | ------------------------------------------------------------------ |
| A field, a rule, a use case                   | `core/model`, `core/rules`, `core/services`                        |
| A route, a request or response shape          | `contract/v1/routes.ts`, `schemas.ts`; then a handler in `http/v1` |
| A second storage backend                      | `server/storage/<name>`; it must pass `test/conformance`           |
| A new thing the core must ask the outside for | A port in `core/ports.ts`, an adapter under `server/`              |
| Wiring of a new service                       | `server/cli/serve.ts`                                              |
| A screen                                      | `web/pages`, composed of `web/features`                            |
| A piece of user-facing functionality          | `web/features/<name>/` with an `index.ts`                          |
| A generic UI primitive                        | `web/shared/ui`                                                    |
| A call to the server                          | `web/api`                                                          |

After a change to the route table, `UPDATE_DOCS=1 npm test` regenerates [api.md](api.md).

## Tests

`test/` is organized by what it checks, not one-to-one with `src`: `core` and `contract` for
the inner ring, `api` and `server` for HTTP behaviour, `storage` and `conformance` for the
`Storage` port, `git`, `config` and `cli` for their adapters, `lint` for the boundaries,
`docs` for documentation checks, `web` for the page, `pack` for the published package and
`e2e` for the browser. `npm run test:pack` and `npm run test:e2e` build first and are not part
of `npm test`.
