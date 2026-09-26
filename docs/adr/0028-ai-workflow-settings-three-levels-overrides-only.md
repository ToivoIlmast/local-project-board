# ADR-0028: AI workflow settings: three levels, overrides only, `.board/workflow.yaml`

Status: proposed (2026-09-26)

## Context

How an agent works on a task — its own branch, checks, a commit, a push, a report — is not
configurable. `GET /instructions` describes only the mechanics of the API (ADR-0026), so the
order of work is written by hand into the text of every task and drifts from task to task.

The settings must be changeable at three levels: the whole board, a column (status) and a task.
They are edited from the page and by agents, so the server has to write them. Configuration
(ADR-0021) is read once at startup, from four layers, and is never written by the server; board
state lives in `.board/` (ADR-0001), is read from disk on every request (ADR-0019) and is
written atomically.

## Decision

- **Settings.** Six booleans can be overridden on any level: `editCode` (default `true`),
  `branch` (`true`), `checks` (`true`), `commit` (`true`), `push` (`false`), `report` (`true`).
  Four settings exist only for the board, because they mean nothing for a column or a task:
  `startStatus` (default `in-progress` if the board has that status, otherwise `null`),
  `finishStatus`, `baseBranch` and `checkCommand` (all default `null`). For these, `null` is a
  value ("no status change", "the repository's main branch", "the project's own pipeline"),
  not a missing key.
- **Only overrides are stored; the effective settings never are.** The defaults are a constant
  in `core/rules/workflow.ts` (`DEFAULT_WORKFLOW`, like `DEFAULT_AI_RULES`). The board's and the
  columns' overrides are in `.board/workflow.yaml`; a task's are in the optional `workflow:`
  field of its `task.md` frontmatter. Each holds only the keys somebody set.
- **One pure function computes the result.** `resolveWorkflow(defaults, board, status, task)`
  merges the four objects flat: a key set on a later level wins, key by key. There are no
  per-key strategies, priorities or conditions. It returns the values, the source of each
  (`default | board | status | task`) and the list of inactive settings.
- **Dependent settings are not repaired.** With `editCode: false`, the values of `branch`,
  `checks`, `commit` and `push` are returned as configured and listed as `inactive`; switching
  `editCode` back on restores exactly what was set. Showing this is up to the handoff and the UI.
- **Some rules are not settings:** an agent never merges, does not commit to the base branch
  when `branch` is on, and does not write the session token into any file.
- **Why a file in `.board/` and not `board.config.yaml`.** The settings are edited at run time
  by the page and by agents, so the server writes them; ADR-0021 keeps configuration read-only.
  A column's overrides are keyed by status, and the list of statuses stays in the configuration;
  `workflow.yaml` does not repeat it.
- **`Storage` port:** `readWorkflow()` and `writeWorkflow()` next to the tasks. The markdown
  provider reads the file on every call and writes it atomically; a missing file is empty
  overrides, not an error. `NewTask` and `TaskPatch` carry the task's `workflow` (a patch
  replaces it whole; `null` clears it). The in-memory provider implements the same, and the
  conformance suite covers both (ADR-0004).
- **A file that does not fit is reported, not fatal (ADR-0022).** A `workflow.yaml` that is not
  readable, is not valid YAML or does not pass the schema (unknown key, wrong type, a board-only
  key in a column, an unknown `formatVersion`) is listed in `readIssues` as `workflow.yaml`, and
  the board runs on the defaults. The same goes for overrides that name a status the board does
  not have (a column, `startStatus`, `finishStatus`): they are reported by `readIssues`, using
  `findWorkflowIssues`, and left in place — the provider is given the configured statuses for
  this. A task whose `workflow` does not fit is an unreadable task like any other.
- **File format.** `workflow.yaml` starts with `formatVersion: 1` (required, like `board.json`),
  then optional `board:` and `statuses:` sections.
- **Snapshot.** `BoardSnapshot` gets a `workflow` part with the board's and the columns'
  overrides (the tasks bring their own), so `formatVersion` becomes **2**: the schema is strict,
  and a version-1 file no longer has the shape of a version-2 one. Nothing reads snapshots yet
  (ADR-0009), so no migration exists, but a future import can tell the two apart.

## API (T14)

The settings are served by the same route table as everything else (ADR-0005); nothing here is a
second model, and only overrides are ever accepted.

- `GET /workflow` answers `{ defaults, board, statuses }`: the stored overrides of the board and
  of its columns, next to the defaults they lie over. `PUT /workflow` takes `{ board, statuses }`
  — **both required**, so a request that leaves one out cannot wipe it unnoticed — and replaces
  both whole (last-write-wins, ADR-0018). It answers like `GET`. The `defaults` of an answer are
  not accepted back: sending the answer as a request is a 400, so a computed value cannot become
  an override.
- An unknown status in `statuses`, `startStatus` or `finishStatus` is a 422 `UNKNOWN_STATUS`,
  found by `findWorkflowIssues` (the check the markdown provider already reports with), and
  nothing is written. Every other misfit — an unknown key, a board-only key in a column, a wrong
  type — is a 400 `INVALID_REQUEST` from the schemas of T13.
- `GET /tasks/:id/workflow` answers what `resolveWorkflow` returns for the task on this request:
  `values`, `sources` and `inactive`. There is no such route for the board as a whole, because
  effective settings only mean something for a task.
- A task's own overrides travel in `POST /tasks` and `PATCH /tasks/:id` as `workflow`. An object
  replaces them whole, as `labels` does (the `Storage` decision above); `null` removes them;
  leaving the key out leaves them alone. The task accepts only the six booleans.
- `workflow.updated` (SSE) carries the state that `PUT` answered. A task's overrides arrive as
  `task.updated`; a hand edit of `workflow.yaml` as `board.changed`. The page takes all three
  from the server and applies nothing before it has answered (ADR-0025).
- For agents (`ai.include`): `GET /workflow` and `GET /tasks/:id/workflow` are documented,
  `PUT /workflow` is not — it is the Settings page's request, and an agent should not rewrite
  the rules it works under in one call. It can still be made; the token allows it.

## Consequences

- The first task of the chain is small: model, rule, port, provider. The API (T14), the handoff
  (T15) and the pages (T17, T18) read the settings only through `resolveWorkflow`.
- `workflow` is now a field the board owns in a task's frontmatter. A hand-written `workflow:`
  that does not fit the schema is reported as an unreadable task instead of being kept as an
  unknown field; the field has not existed before, so no board is expected to have one.
- A snapshot of a board whose `workflow.yaml` is unreadable carries empty overrides, as it omits
  unreadable tasks: it describes what the board runs on. The file itself is untouched.
- A change made directly to `.board/workflow.yaml` is seen on the next request; the watcher
  already reports it to open pages as a board change.
- The number 0027 that the task text names was taken by the README translation check meanwhile.
