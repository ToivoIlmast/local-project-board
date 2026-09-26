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

## Handoff (T15)

An agent gets one text for one task, and it is generated: nothing about how to work is written
by hand into a task any more, and there is no second set of rules next to the settings.

- `GET /tasks/:id/handoff` answers markdown (`ai.include: true`, read without a token, 404
  `TASK_NOT_FOUND` for a task that is not there). `local-project-board handoff <id>` prints the
  same text — from the running board, or, when there is none, composed from the files of the
  board. Both go through one function, `composeHandoff`, so the two cannot differ.
- The text is: the task (id, title, status, labels, branch, body), its documents, the section
  "How to work on this task", and then the general instructions of the board **without a
  token** — the agent asks `GET /session` for one, as those instructions already say. The
  handoff is generated on every request from what the services read, is the same for the same
  state of the board, and is stored nowhere.
- **The settings reach the text through one function.** `renderWorkflowSteps(effective, facts)`
  is the only place in the board that says anything about how to work. It is given the
  `EffectiveWorkflow` that `WorkflowService.forTask` computes with `resolveWorkflow` — the same
  answer as `GET /tasks/:id/workflow` — and works out nothing itself: not a value, not a
  source. There is one step for each setting and a text for each of its values; a setting that
  is off is an explicit prohibition ("Do not push"), never silence, so that `push: false` cannot
  be read as permission. While `editCode` is off, `branch`, `checks`, `commit` and `push` are
  each an explicit "do not", whatever their value is (the `inactive` list of T13), and
  `editCode: false` says that no project file is to be changed and where the result goes.
  `baseBranch` and `checkCommand` are parameters of the branch and checks steps, not steps of
  their own (`WORKFLOW_STEP_PARAMETERS`); the steps are typed per key, so a setting added to
  the model without a text does not compile.
- Each step names where its value came from: the default, the board, the column the task is in,
  or the task itself — the `sources` that T13 already returns; there is no second bookkeeping
  of origins.
- The rules that are not settings are the last steps, always: never merge, never write the
  token into a file, a task, a document or a report, stop and wait for the review. That the
  branch is not committed to is part of the branch step, because it only holds when there is one.
- `GET /instructions` gets a short section, "Working on a task": read the handoff before
  starting. It repeats no step.
- **Branch name.** `taskBranchName(id, title)` in `core/rules` is `task/<ID>-<slug>`. The slug
  is the Latin words of the title, lower-cased, at most 40 characters cut at a word; accents are
  dropped and no other script is transliterated, so a Cyrillic title gives only its Latin words
  and a title without any gives `task/<ID>`. A branch the task already records is used instead.
- **Language.** The text is English, like the rest of the instructions; the body of the task is
  copied as it was written. The two are not mixed by translating anything.

## Rules of the agent (T16)

This supersedes ADR-0026. `ai.rules` replaced a built-in list as a whole, so a project that added
one line of its own silently took the API's rules away from the agent (against ADR-0005), and
nothing kept it from writing "create a branch" there, a second answer to what the settings say.
Three things describe what an agent does, and each has one place:

- **API rules** — facts about the contract (JSON, unknown fields are rejected, `move` by
  neighbours, document names, limits). `API_RULES` in `contract/v1/instructions.ts`, next to the
  route table it describes (ADR-0026 said so; T12 had put the constant in `core/rules`, which
  the config no longer needs). They are always in the instructions and nothing overrides them.
  None is about how to work: a test rejects the words of the settings in them.
- **Project rules** — `ai.rules`, a list of strings, default `[]`: conventions that no setting
  expresses (the language of comments, the style of commit messages). They are added after the
  API rules under "### Project rules", never in place of them; an empty list leaves the
  subsection out, and a line that is exactly an API rule is not said twice. Between config layers
  the list is replaced whole (ADR-0021), which now only ever replaces the project's own lines.
  Nothing parses them: a rule that contradicts a step is a mistake in the project's text, and the
  subsection tells the agent that they replace neither the API rules nor the steps. No merge
  by key, no ids: a list of strings, added at the end.
- **How to work** — the settings, through `resolveWorkflow` and `renderWorkflowSteps`, and
  nowhere else. Whether files may be changed is `editCode` alone.

`ai.allowSourceEdits` is removed. Nothing read it, and its default (`false`) is the opposite of
`editCode` (`true`), so keeping it beside the setting would show a ban that never applied. A
config that still has it stops the board with an issue that names `editCode` and
`.board/workflow.yaml`, like any other invalid key (ADR-0021); it is not silently ignored.

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
- A board whose config copied the eight built-in rules to add its own keeps working: the copies
  are not repeated. One that wrote its own instead of them now has the API rules as well.
