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
names, AI rules) and the services (`services/`) that implement the use cases on top of the
ports. `contract/v1` holds the zod route table, the request and response schemas, and what is
generated from them: [api.md](api.md) and the AI instructions (ADR-0005, ADR-0012).

## The server

| Directory                                 | Role                                                       |
| ----------------------------------------- | ---------------------------------------------------------- |
| `src/server/storage`                      | Implements `Storage`; the markdown adapter (ADR-0002/0004) |
| `src/server/git`                          | Implements `GitReader` over the system `git` (ADR-0007)    |
| `src/server/events`                       | Implements `EventSink`; in-process bus for the SSE stream  |
| `src/server/config`, `src/server/project` | Configuration and board-root discovery (ADR-0021/0024)     |
| `src/server/http`                         | Express: routes, errors, security, SSE. Nothing else       |
| `src/server/cli`                          | Arguments, the composition root, listening, `runtime.json` |

`src/server/cli/serve.ts` is the only place where the pieces are put together: it creates the
event bus and the storage, builds the services, and hands `http` a `BoardContext`. A route can
therefore do only what a service already offers, and a service never learns that there is a
token. Security is in `http/security.ts` (ADR-0008).

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
