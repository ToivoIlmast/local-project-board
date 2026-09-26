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
  in `core/rules/workflow.ts` (`DEFAULT_WORKFLOW`). The board's and the
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

## The Settings panel (T17)

The page for the board's and the columns' settings reads and writes only what the API of T14
does; there is no second model and nothing is stored in the browser.

- **One more panel, no router.** `?panel=settings` beside `reports`, `git` and `instructions`
  (ADR-0025: what the page looks at lives in the address). One form, one button, one
  `PUT /workflow` with both sections whole.
- **The form edits overrides, never effective values.** Its draft has the shape of the request.
  What is in effect, and where it comes from, is computed for display from the `defaults` of the
  answer with the rule `resolveWorkflow` uses; a test compares the two for every combination, so
  the page cannot drift from the function. Consequences: a board checkbox that only repeats the
  default is not stored (put back where it was, the form is clean again); "same as the board"
  removes the key from the column, and a column left empty is not sent; a blank text is no
  override; an explicit `null` that was in the file and was not touched is sent back as it was.
  A column only has the six flags — the board-only keys are not offered there, and the request
  has no `defaults`.
- **Dependent settings are shown, not repaired.** With `editCode` off (on the board, or in a
  column, from what that column has in effect) `branch`, `checks`, `commit` and `push` stay
  editable and keep their values; they are marked as unused, in words and by a dashed rule, not
  by colour or opacity alone.
- **The form does not lose what is being typed.** A `workflow.updated` or a re-read of the board
  (`board.changed`) is taken silently by a form with nothing unsaved. A form with changes keeps
  them and says that the settings changed elsewhere, with a button to load the new ones;
  saving then replaces the other change (last-write-wins, ADR-0018). The answer to the form's
  own request is recognised as its own. Nothing is applied before the board has answered
  (ADR-0025).
- **A status that is gone is shown.** A column, `startStatus` or `finishStatus` naming a status
  the board does not have is listed as a warning and kept in the form; the board refuses to save
  it (422 `UNKNOWN_STATUS`, message shown in the form), so the person removes it or picks a
  status.
- **Not here:** a task's own overrides (see the next section) and `ai.rules`, which is
  configuration (ADR-0021, "Rules of the agent"), not stored by the server and not part of the
  API; the panel only says where it lives. The words of every setting are `WORKFLOW_LABELS` in
  the feature, which the block of a task reuses.

## The AI block of a task (T18)

The details of a task get a block "AI": what an agent will do on this task, the exceptions this
task makes, and a menu that hands the task to an agent. It uses the routes of T14 and T15 as
they are (`GET /tasks/:id/workflow`, `PATCH /tasks/:id`, `GET /tasks/:id/handoff`); nothing in the
contract changed apart from the page's client getting `handoff(id)`.

- **Two kinds of value, kept apart.** What is _in effect_ is only ever the board's answer
  (`GET /tasks/:id/workflow`, with the source of each value and the `inactive` list): the page
  does not run `resolveWorkflow`. What is _edited and stored_ is the task's own overrides. The
  answer is asked for again whenever something it depends on changes — the task's status, its own
  settings, the settings of the board and the columns (`workflow.updated`, `board.changed`) — and
  while it is on its way the block says so instead of showing the answer to an earlier question.
- **The one place the page works something out** is the text of the "inherit" choice, "Inherit
  (now on, from the column todo)": what the task would have if it said nothing. The board cannot
  answer that for a task that does say something, so it is taken from the board's overrides with
  `effectiveFlag`, the function of the Settings panel that a test holds to `resolveWorkflow` for
  every combination. It is never sent anywhere.
- **Same three states as a column, one control.** Inherit, on, off — the `FlagChoice` of the
  Settings panel, its words (`WORKFLOW_LABELS`, `sourceLabel`) and its draft (`useOverridesDraft`,
  the hook the panel's form is made with). A task can only override the six on/off settings; the
  four board-only ones are listed as in effect, with their source, and are changed in Settings.
- **`PATCH` replaces the overrides of the task whole** (T14), so the draft is the whole object
  and one changed setting sends the others the task already had. When nothing is left the page
  sends `workflow: null`, never `{}`: `null` is how the board is told to remove the overrides,
  and no `workflow` at all is what "no override" is. A stored `{}` is read as no override too.
  "Reset to the settings of column …" sends `null` at once and drops what was typed.
- **Nothing outside the task is touched.** The block never calls `PUT /workflow`; the board's
  and the columns' overrides are the same bytes before and after (tests on a real board).
- **Nothing is applied before the board answers**, and nothing typed is lost (ADR-0025, the same
  rules as the panel): an error stays next to the form with the draft intact; a change made
  elsewhere (`task.updated`) is taken silently by a block with nothing unsaved and reported, with
  a button to load it, by one with changes; a save is recognised as one's own.
- **Folded away when there is nothing to show:** a task with no overrides is one line, "Uses the
  settings of column todo", and a button to open it. A task with overrides, or a block being
  edited, is open. Folding away after the last override goes returns the focus to the button that
  opens it. The card on the board carries a mark ("AI settings") when the task has overrides.
- **Send to AI** is a menu whose entries are a list of `{ label, run(taskId) }`. The first is
  "Copy handoff": the text of `GET /tasks/:id/handoff`, fetched when the entry is chosen — the
  page composes nothing, so it is the text of the API and of `local-project-board handoff`, and
  has no token (T15). A further way to send a task is one more entry in the list. The result is
  announced in a polite live region; a failure of the board, or a browser that refuses the
  clipboard, is said in words and copies nothing.

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
