# ADR-0030: Task history: content versions and actuality checks, append-only

Status: accepted (2026-10-17, owner's decision; implemented by T46). Amendment for Research (T54):
proposed, see the end.

## Context

T46 adds two things to every task, in every status: **versions** of its content, with a
selector, a diff and restore; and an **actuality check**, an AI run that compares the task
with the repository and leaves an immutable report whose recommendations the person accepts or
rejects one by one.

What the board has today does not carry either:

- A task is one `task.md`. `PATCH` is last-write-wins (ADR-0018), so nothing protects an edit
  from being overwritten, and nothing keeps what was overwritten.
- `task.md` can change behind the server's back (ADR-0019): an editor, or an agent writing the
  file. And `.board/` is untracked (ADR-0001), so git keeps no history of it either.
- Documents are overwritten by `PUT` and removed by `DELETE`; board reports (`R<n>`) belong to no
  task and are removed by `DELETE /reports/:id`. Neither is immutable.
- A **check report** in this ADR is not a report in the sense of ADR-0003. It is a structured
  record in a task's history, read by the board, with an id of its own kind. ADR-0003 is
  unchanged: board reports stay `.board/reports/<id>.html|md`, and documents stay documents. The
  history is files too (§2), so the promise of ADR-0003 holds for it as well.
- A task has one `aiRun`, and the next run replaces it (ADR-0029, T31). A check stored there would
  erase the record of the work.
- The server starts no process (ADR-0029). A check has to be started the way a run is.

## Decision

### 1. What is versioned

- **A version's snapshot is the task's content: `title`, `body`, `labels`.** Nothing else
  (owner's decision, 2026-10-17).
  - `status` and `rank` are the task's place on the board. Restoring an old version must not
    move the task.
  - `branch` is a link to the work, written by the AI run (T28) and renamed on Restart (T37).
    Restoring an old one would point the task at an archived branch, and the branch PATCH at the
    start of every run would make a version.
  - `workflow` is how an agent runs (ADR-0028), not what the task says. `aiRun`, `createdAt`,
    `updatedAt` and `extra` are not edited as content.
  - These fields stay last-write-wins, outside history, as they are today.
  - Acceptance criteria, dependencies and related tasks stay **sections of `body`**. No field is
    added to `Task` for them. A structured field would need a migration of every task and a form
    of its own, for text that markdown already holds.
- **A change of the content makes a version; anything else does not.** Content is compared
  exactly: a string differs in one character, labels differ as ordered arrays. Equal content
  makes no version, whatever the request was.
- **`contentHash(content)`** is one pure function in `core/rules`, re-exported by `contract/v1`
  for the page: a deterministic 64-bit hash (FNV-1a over the canonical JSON of
  `[title, body, labels]`, 16 hex digits). It is not a security mechanism, only a short way to
  say "the content I saw". The same function runs on both sides, so the page never asks the
  server for it.

### 2. Entities, all append-only

Everything lives under `.board/tasks/<id>/history/`. Documents never see the directory:
`listDocuments` lists files with document names only, and `history` is a directory.
**Every history file is created once, exclusively (`wx`), and never rewritten or removed.** The
only exception is the deletion of the task itself (§8). Numbers are per task, `max(existing) + 1`
under the per-task lock (§3), counting files that cannot be read too, so a broken file is never
overwritten. Task ids are never reused (ADR-0020), so `(taskId, number)` is unique for the life
of the board.

| Entity | File | Written by |
| --- | --- | --- |
| Version | `history/versions/<n>.json` | the task service, on a content change |
| Check, begin | `history/checks/<n>.begin.json` | the runner (begin route) |
| Check report | `history/checks/<n>.report.json` | the agent (report route) |
| Check, end | `history/checks/<n>.end.json` | the runner (end route) |
| Decision | `history/checks/<n>.decisions/<k>.json` | the person (decision route) |

- **Version** `{taskId, number, createdAt, source, changed, snapshot, restoredFrom?, fromCheck?}`.
  - `source` is one of:
    - `create`: `POST /tasks`;
    - `baseline`: the content as the board first saw it, for a task that had no history;
    - `external`: content that changed outside the server, recorded when found;
    - `edit`: `PATCH`, from the page or any client: the API has one token and cannot tell a
      person from an agent, so the source does not claim to;
    - `restore`.
  - `changed` lists the fields that differ from the previous version. That is the only summary
    the board can state reliably. It is empty for `create` and `baseline`.
- **Check** is three write-once files. Its state is derived, never stored:
  - begin only: `working`;
  - begin and report: `reported`;
  - begin and end without a report: `failed`.

  `begin` `{taskId, number, version, createdAt, agent, sessionId, model?, repo}` pins the version
  the check reads. `repo` is `{branch, head, clean}` from the read-only GitReader, or `null`
  without git.
- **Check report** `{taskId, check, version, createdAt, agent, verdict, summary, uncertainty?,
  findings, recommendations, repo}`:
  - `verdict` is one of `current`, `partly-outdated`, `outdated`, `insufficient-data`.
  - `findings[]` is `{id, title, explanation, evidence[]}`. Evidence is
    `{kind: file|commit|task, ref, note?}`.
  - `recommendations[]` is `{id, findings[], text, edit?}`. `edit` is one of
    `{field: title, value}`, `{field: labels, add[], remove[]}` or
    `{field: body, find, replace}`.
  - `repo` is read again when the report arrives, so a repository that changed during the check
    shows.
  - What the agent sent is stored as sent and shown as stored. Nothing is recomputed.
- **Decision** `{taskId, check, recommendation, decision: accepted|rejected, note?, createdAt}`.
  Decisions are history: the latest one per recommendation is its current state, and the
  earlier ones stay. A decision changes no task.
  - It is accepted only for a `reported` check. A check that is `working` or `failed` has no
    recommendations to decide on: `409 CHECK_NOT_REPORTED`.
  - Its `recommendation` must be an id in that report: `404 RECOMMENDATION_NOT_FOUND`.
  - A check that does not exist: `404 CHECK_NOT_FOUND`.
  - Nothing is written on any refusal.

The Storage port gains only methods that add or read: `appendVersion`, `listVersions`,
`readVersion`, `beginCheck`, `writeCheckReport`, `endCheck`, `listChecks`, `readCheck`,
`appendDecision`. There is no method to update or delete history, so no route can either. A
history file that cannot be read is a read issue (ADR-0022) and is left out of the lists.

### 3. When versions are made: one locked section per task

**Every write to a task's content or history runs under the per-task lock that the aiRun
lifecycle already uses** (`TaskLocks`, T45; one instance shared by the services). These are:

- a `PATCH` that carries `title`, `body`, `labels`, `ifContentHash` or `fromCheck`, so a `PATCH`
  of `status` alone with a precondition is checked and written in one section too;
- `POST /tasks` (the `create` version);
- restore;
- check begin, report and end;
- a decision.

A `PATCH` that carries none of these fields stays outside, as today. The lock is a promise queue
and cannot be re-entered: a request takes it **once**. Everything the request reads, checks and
writes happens inside that one acquisition, and nothing inside it calls back into another locked
operation.

Inside the lock, in this order:

1. **Read** `task.md`, and the history the request needs.
2. **Check every precondition**, before anything is written:
   1. `ifContentHash` against the content just read (§4);
   2. `fromCheck`, against the check, its report and its decisions as just read (§7);
   3. the existing rules (status, `aiRun: null`).

   The first that fails answers, and nothing is written, not even the sync.
3. **Sync.** If the task has no history, append a `baseline` version of its current content. If
   its content differs from the latest version, append an `external` version of it. Either way,
   history now ends at what is on disk.
4. **Write.** If the new content differs, write `task.md` first, then append the version
   (`edit` or `restore`, carrying `fromCheck` when given).

Decisions and check reports are written under the same lock, so a decision that rejects a
recommendation cannot pass between the check of a `fromCheck` and the write it allows. The lock
orders the board's own writes only. An editor that writes `task.md` between step 1 and step 4
is outside any lock of the board (ADR-0019). Its change is recorded as `external` by the next
sync if it survived, and is otherwise overwritten as by any last write.

The order of step 4 is deliberate. A crash between the two writes leaves `task.md` ahead of
history, and the next sync records that content as `external`: nothing is lost, only labelled
`external`. The reverse order would leave a version that never became the task.

- **Existing tasks get no migration.** Their first content write or check makes `baseline` v1,
  so `board.json` keeps `formatVersion: 1`. An earlier version of the board ignores `history/`.
  What it writes is found later as `external`.
- **Changes made outside the server** are recorded when the next write or check finds them, not
  when they happen. No watcher is relied on (ADR-0019). Two edits made outside the server
  between two board writes leave only the second. That is the known limit.
- **`GET` never writes.** The list of versions says whether the task's current content is the
  latest version (`current: {hash, version | null}`; `null` means "changed outside history").
  The page shows that state as the current entry without recording it.
- `move` and a `PATCH` of `status`, `branch`, `workflow` or `aiRun` alone touch no history.

### 4. Concurrent edits: an optional content precondition (amends ADR-0018)

- **`PATCH /tasks/:id` gains `ifContentHash?`**: the `contentHash` of the content the client
  based its change on. It is compared, inside the lock, with the content read in the same
  section (§3). If the content hashes differently, the answer is `409 TASK_CONTENT_CHANGED`
  with `{currentHash, latestVersion}`, and nothing is written, not even the sync. Two saves
  based on the same content therefore cannot both succeed: the second sees the first one's
  content. A request without it is last-write-wins exactly as today, so agents and older
  clients are unaffected. This is the "optional precondition field" ADR-0018 foresaw.
- **The page always sends it**, and from the edit form it sends **only the fields the person
  changed**. Today the form sends `status`, `body`, `labels` and `branch` whole on every save. A
  save during a run then quietly returns the status an agent had set; that stops.
- On a 409 the page keeps the draft and shows it against the new current content. The person
  saves again or drops the draft. Nothing is merged automatically.
- The precondition covers content only. A conflict on `status` or `branch` stays
  last-write-wins: those fields are small, are shown on the card, and are not versioned.

### 5. Restore

`POST /tasks/:id/versions/:n/restore` `{ifContentHash}`. Here the precondition is
**required**: a restore replaces the whole content.

- It writes the snapshot of version `n` as the content and appends a `restore` version with
  `restoredFrom: n`.
- If that equals the current content, nothing is written and the answer says so.
- It touches no other version, no field outside the snapshot (the status stays), and no check
  or report.

### 6. The actuality check

**Started like a run, recorded apart from `aiRun`** (amends ADR-0029). The server still starts
nothing.

- **`POST /tasks/:id/run` gains `kind?: 'work' | 'check'`**; absent means `work`, unchanged.
  - A check takes no `mode`, or only `new`: a check is always a new session.
  - A check is not refused while a work run is `working`, nor while another check is: it changes
    nothing that they own.
  - `run.requested` carries `kind: 'check'` only for a check, as T36 did for `mode`.
  - The CLI gains `local-project-board claude <ID> --check`.
- **Begin.** The runner calls `POST /tasks/:id/checks` `{agent, sessionId, model?}` (not given to
  agents). Under the task lock this syncs history (§3), so the check is pinned to a version that
  exists and equals what is on disk, and records `begin`. The answer is `{number, version}`.
- **The agent reads `GET /tasks/:id/checks/:n/handoff`**, not the task's handoff. It holds:
  - the **snapshot of the pinned version**, not the live task, so the agent reads exactly what
    the report will be bound to;
  - the list of the task's documents;
  - the rules;
  - the report format and route.

  It is not generated from the workflow settings (ADR-0028): a check never edits code, branches,
  commits, pushes or moves the task. Only `reportLanguage` applies, to the text of the report.
  The rules forbid changing files of the project, any git command that writes, and any write to
  the board other than the report route. **This is instruction, not enforcement**: one token
  (ADR-0008) cannot be narrowed per route. The evidence is `repo` at begin and at report. No
  check route writes `task.md`.
- **Report.** `POST /tasks/:id/checks/:n/report`, by the agent. It is accepted once, and only
  while the check is `working`; otherwise the answer is `409 CHECK_ALREADY_FINAL`.
  - It is validated against the pinned snapshot. Every body `edit.find` must occur **exactly
    once** in that body, and a title edit must not be blank. If not, the answer is
    `422 INVALID_CHECK_REPORT`, and the agent fixes the report and sends it again.
  - Recommendation and finding ids must be unique, and evidence refs must be well formed. A
    task ref must look like a task id; it is not looked up.
- **End.** `POST /tasks/:id/checks/:n/end` `{sessionId, exitCode?, endedAt?}`, by the runner,
  once. A session other than the begin's gets `409 STALE_CHECK`; a second end gets
  `409 CHECK_ALREADY_FINAL`.
- **The runner keeps a journal of a check, apart from the journals of work runs.** It reuses
  T45's way of writing (temp file, `fsync`, rename, owner-only, no token) and its retry of the
  end for ~30 s, but not its namespace, its schema or its rules for dropping.
  - **File:** `.board/runner/<ID>-check-<n>.json`. A work run's journal is `<ID>-<runId>.json`
    with an integer `runId`, so the two cannot share a file name, and check 3 cannot overwrite
    the journal of run 3. `readJournal`/`removeJournal` build only the integer form and so never
    reach a check journal.
  - **Schema:** a schema of its own with `kind: 'check'` and `check: <n>` in place of `runId`.
    The work-run schema stays exactly as it is (`formatVersion: 1`, strict, no `kind`).
  - **`listJournals` keeps parsing every `.json` with the strict work-run schema**, so it skips
    a check journal as unreadable ("left where it is"), in this version and in every CLI before
    T46. A check journal therefore never reaches `deliverEnd` (`/ai-run/:runId/end`), the
    `replaced` rule (which compares with `aiRun.runId`), or `claude --recover`. The check
    runner's own listing takes only the `-check-` names, with its own schema.
  - **Delivery:** the end goes to `…/checks/:n/end`. The journal is removed on `2xx`, `404` (the
    task or the check is gone) or `409` (already ended, or another session); otherwise it is
    kept for the next try. This is the same rule as `deliverEnd`, with the board's check of the
    session deciding, not the CLI.
  - **A journal without an outcome** (the runner died before `claude` ended) is never judged
    against `aiRun`. It is dropped once the board answers `404` for the check, or shows it with
    an end or a report: nothing it holds can change the check any more. Otherwise it stays.
  - **`claude --recover` is not extended and is unchanged**: it reads the journal of a work run
    by its integer name only. A check that never ends stays `working`, blocks nothing, and is
    shown as having no report.
- **`aiRun` is never read or written by a check.** A check is not an attempt at the work.

### 7. Applying recommendations

- **Staleness is a comparison, not a flag.** A report is stale when the task's current
  `contentHash` differs from the hash of its pinned version's snapshot. The page shows that, and
  the version numbers, on the report.
- **Applying is a pure function** in `core/rules`, re-exported by the contract:
  `applyRecommendations(content, recommendations)`.
  - It applies the accepted `edit`s in order onto the content and returns the draft, plus the
    recommendations it could not apply.
  - A body `find` must still occur exactly once after the earlier edits. If it does not, that
    one is left out and named.
  - A recommendation without `edit` is advice and is never applied, only shown beside the
    editor.
- **The page applies only when the report is not stale.** When it is stale, it offers a new
  check, or manual reconciliation: the editor on the current content, with the recommendations
  listed beside it and none applied.
- **The save is an ordinary edit (§4) that carries `fromCheck?`**
  `{check, recommendations[], basis: report|manual}`. It is recorded on the new version, which
  is the link from a decision to the version it produced. If the content does not change, no
  version is made, and `fromCheck` is recorded nowhere.
- **`fromCheck` is checked inside the lock, after `ifContentHash` (§3, step 2).** The first
  failing check answers:
  1. the check must exist: `404 CHECK_NOT_FOUND`;
  2. it must be `reported`: `409 CHECK_NOT_REPORTED`;
  3. every named recommendation must be in its report: `404 RECOMMENDATION_NOT_FOUND`.

  Then, for `basis: report` only:

  4. `ifContentHash` is required (a request without it is `400 INVALID_REQUEST`);
  5. the current content must equal the pinned version's snapshot, and every named
     recommendation's latest decision must be `accepted`. Otherwise the answer is
     `409 STALE_CHECK`, so a stale report cannot be applied unnoticed, even by a client that
     skips the page.

  `basis: manual` stops after step 3: the person has reconciled by hand, against the current
  content.
- **Nothing is applied without a person.** No route applies a recommendation, and a decision
  writes no task.

### 8. Deletion, events, export

- **Deleting a task deletes its history with it**, like its documents (owner's decision,
  2026-10-17). The rule "history is never deleted" holds for every ordinary operation. Deleting
  the task is the one explicit, confirmed act that ends it. Ids are never reused, so nothing
  later inherits the history, and export (below) is the backup.
- **Events**: `version.created {taskId, number}` and `check.updated {taskId, number}`. The page
  refetches the history of that task. The watcher's `board.changed` covers writes made outside
  the server (ADR-0019).
- **Export** (ADR-0009) carries the history, `formatVersion: 3`: `.board/` is untracked, and a
  backup without the history would lose exactly what this ADR promises to keep.

### 9. Routes and errors (contract, ADR-0005)

New routes:

- `GET /tasks/:id/versions`
- `GET /tasks/:id/versions/:n`
- `POST /tasks/:id/versions/:n/restore`
- `GET /tasks/:id/checks`
- `GET /tasks/:id/checks/:n` (begin, report and decisions)
- `POST /tasks/:id/checks` (runner)
- `GET /tasks/:id/checks/:n/handoff`
- `POST /tasks/:id/checks/:n/report` (agent)
- `POST /tasks/:id/checks/:n/end` (runner)
- `POST /tasks/:id/checks/:n/decisions`

Extended: `PATCH /tasks/:id` gains `ifContentHash?` and `fromCheck?`; `POST /tasks/:id/run`
gains `kind?`.

New error codes:

- `VERSION_NOT_FOUND`, `CHECK_NOT_FOUND`, `RECOMMENDATION_NOT_FOUND` (404);
- `TASK_CONTENT_CHANGED`, `CHECK_ALREADY_FINAL`, `CHECK_NOT_REPORTED`, `STALE_CHECK` (409);
- `INVALID_CHECK_REPORT` (422).

Writes need the session token and pass the host/origin checks (ADR-0008), like every write. The
diff between two versions, or between a draft and the current content, is a pure function in
`core/rules` re-exported by the contract. It needs no route.

## Consequences

- One task's data stays in one directory, and nothing the board writes into history is ever
  rewritten. That one invariant is testable in the storage conformance suite (ADR-0004): no
  update or delete method exists, a second report or end is refused, numbers survive reopening,
  an unreadable file is not overwritten, and `deleteTask` removes history.
- Atomicity is testable in the service with the shared lock:
  - two saves with the same `ifContentHash` make exactly one version, and the other gets 409;
  - a rejection racing a `fromCheck` save either lands first, so the save gets `409 STALE_CHECK`,
    or after it, so the version records an accepted recommendation;
  - no refusal leaves a history file behind.
- Journals stay isolated, and that is testable in the CLI: a check journal is not listed as a
  work journal, `--recover` and `deliverEnd` never touch it, and a work journal with the same
  task and number is unaffected.
- Agents keep working unchanged: no precondition means last-write-wins (ADR-0018), and a work
  run sees no new step.
- History is only as fine as the board's own writes for edits made outside the server (§3).
- A check's read-only promise rests on the handoff and the agent's permissions. The board shows
  evidence; it does not enforce.
- Every version is a full snapshot. Size is measured with T9 if it ever matters.
- The core keeps its purity (ADR-0006): `contentHash`, the diff and `applyRecommendations` are
  pure, and the page reaches them only through `contract` (ADR-0013).

## Amendment (T54, 2026-10-24, proposed): Research is a kind of check

Status of this amendment: **proposed**. The owner sets `accepted`. Every rule below is the owner's
decision recorded in a closed Decision task (named in brackets); nothing is decided here that
those tasks did not decide. What is not decided is listed at the end of the amendment.

ADR-0029 carries the other half (how a Research is requested, started and handed to the runner).
ADR-0028 and ADR-0009 are not changed. No ADR-0031 is created (D5, T54).

### R1. One entity, one numbering (D1, T49)

- **Research is a kind of check**, not a new entity and not a new kind of `aiRun`. It has the same
  history, the same numbers (`T21-C<n>`, one series per task for checks of both kinds), the same
  routes (`/tasks/:id/checks/...`), runner journal (`.board/runner/<ID>-check-<n>.json`, §6), lock
  (§3), decisions (§2) and `fromCheck` (§7). Research gets no routes, Storage methods, journal
  namespace or `fromResearch` field of its own. A research and an actuality check of one task
  are numbered `C1`, `C2`, … in the order they began; neither replaces the other.
- **The kind is `kind?: 'research'` in `begin`.** A `begin` without it is an actuality check, so
  every file written before this amendment reads as it did, and no migration is made.
- **A Research report has no `verdict` and no `readiness`** (D9, T49). It holds conclusions and
  recommendations. Whether to accept them, and whether the task is ready to implement, stays with
  the person. The four verdicts of §2 belong to the actuality check only.
- A research is not a board report (ADR-0003) any more than a check is: it is a record in the
  task's history, and its Markdown (R3) is not a document of the task.

### R2. Begin (D1, D12, T49, T50)

`begin` gains optional fields, all absent in an actuality check:

- **`kind: 'research'`.**
- **`comment`**: the focus the person gave, stored as sent. A non-empty string without NUL, **at
  most 4 000 characters** (D12, T50). It is a field of the begin record only: it is never written
  to `task.md`, `workflow`, `aiRun` or a document, and a second research with another comment is a
  new check `n + 1` whose own `begin` keeps its comment.
- **`documents`**: `[{name, size, updatedAt}]` from `listDocuments`, without reading a body, so that
  a later change of the task's documents can be shown against what the research saw.

The version is pinned and `repo` is recorded exactly as §2 says for a check.

### R3. The report: `report.md` and its metadata (D2, D12, T50)

A Research report is a narrative Markdown text that cannot be changed. It is two write-once files
(`wx`, §2), written in this order:

1. **`history/checks/<n>.report.md`**: the text.
2. **`history/checks/<n>.report.json`**: the structured record, with `markdown: {bytes, hash}`
   describing the file written first.

- **The report is published only when `<n>.report.json` exists and is valid.** A `<n>.report.md`
  without it is not a report; the research stays `working` (§2, state is derived).
- **Partial write.** If the process ends between the two writes, the agent may send the report
  again.
  - With **the same bytes** for the Markdown, the first file is kept and the second is written:
    the repetition continues the work.
  - With **different bytes**, nothing is written and the answer is `409 CHECK_ALREADY_FINAL`.
    The research stays `working`, blocks nothing, and is shown as having no report. No suffixed
    name is made, and no file is replaced.
- **Limits** (D12, T50): the Markdown is **at most 200 000 characters**; `changes.files` (R5) at
  most **200 paths**. A report over a limit is `422 INVALID_CHECK_REPORT`, and nothing is written.
  The limits are the initial ones; no measurement of performance stood behind them.
- The structured part keeps `summary`, `findings`, `recommendations`, `uncertainty?` and `repo`
  as in §2, without `verdict`. For a research the Markdown is required; for an actuality check
  it does not exist.
- The Markdown is read through its own route, `GET /tasks/:id/checks/:n/report.md`
  (`text/markdown`; `409 CHECK_NOT_REPORTED` until the report is published, as for a decision), and is not given to
  agents. No other route reaches the file. It is **not a document of the task**: `listDocuments`
  never sees `history/` (§2), and no route that writes documents can name it. It is not listed or
  parsed by the lists of checks or by the read issues of the board: they read its size and hash
  from the metadata, not the text.
- `formatVersion` of the export stays **3** (D8, T50): the history is exported as §8 says, with
  the new files and fields. If the implementation finds a real incompatibility with the current
  schema, that is a new question for the owner, not a bump made on the way.

### R4. Recommendations: targets, decisions, application (D4, D6, T52)

- **A recommendation may name `targets`**: a description, not an edit. Each is one of
  `{kind: task}`, `{kind: document, name}` or `{kind: file, ref}` (`ref` is checked as an
  evidence ref of kind `file` is, §2).
- **Apply works on the task alone.** The only thing a button applies is an `edit` of `title`,
  `labels` or `body`, through §7 as it is. A recommendation aimed at a document or a file of the
  project is applied by nobody: the person carries it over by hand through the existing
  **Reconcile by hand** (`fromCheck.basis: manual`, §7). The server does not write the files of the
  project (ADR-0007, ADR-0029) and documents have no versions or content precondition.
- **Not in scope of this decision:** passing accepted recommendations to the handoff of the
  implementation (D4-b) and applying edits to documents automatically (D4-c). Neither is
  introduced; a later one is a new decision, and D4-b would also amend ADR-0028.
- **Only `stale` blocks Apply** (D6, T52): the task's content differs from the pinned version, as
  §7 already says (`409 STALE_CHECK`). A newer research, or a repository that moved on, does not
  block anything; they are shown as notes.
- **Decisions are as §2 says**, and `note` is now used.

### R5. Derived states of a recommendation (T49, T52)

Nothing is stored in addition to what §2 and §7 already write. A recommendation shows three
independent derived values, never one stored status:

| Axis | Values | Derived from |
| --- | --- | --- |
| Decision | `undecided`, `accepted`, `rejected` | the latest decision (§2) |
| Application | `applied in v<n>[, v<m>]`, `not applied`, `not applicable` | versions whose `fromCheck.recommendations` name it (§7); `not applicable` for advice without `edit` and for targets other than the task (R4) |
| Currency | `current`, `stale`, `superseded` | `stale` as in §7; `superseded` when the task has a later check or research that is `reported` |

- `superseded` is a note. It blocks no decision and no Apply (D6), changes no data and is derived
  on each read like the rest.
- A recommendation can be `rejected` after it was applied: the fact of the application stays in
  its version, and undoing it is an ordinary restore (§5).
- The same table holds for a recommendation of an actuality check.

### R6. Read-only: detection, not prevention (D3, T51)

- **The level is E1: the board detects changes; it does not prevent them.** The research handoff
  tells the agent to change nothing, and the board records the state of the repository and shows
  whether it changed. The board **does not promise** that the agent cannot change files or send
  data out: with one token (ADR-0008) and a shell, it cannot. The wording for the page and the
  README is: _"Research is told not to change anything; the board shows whether anything
  changed."_
- **Evidence**: `repo` (`{branch, head, clean}`, §2) at begin and at report, and now **at end**:
  `endCheck` reads it again and stores it. The report may carry `changes: {files, diffHash}`
  (at most 200 paths, R3), read from the read-only GitReader (ADR-0007). A working tree that
  was already dirty at begin is said to be so, and a change is reported as _changed_, without
  blaming the agent: the person may have edited the tree meanwhile.
- **Not decided: E2 and E3.** Flags of access rights for the session (E2) are not a full
  guarantee (T48: the `curl` the agent needs writes files) and the check of the wrapper for POST
  and of the interactive mode was not done. Isolation in a worktree or a clone (E3) needs its own
  estimate and would be a new ADR next to ADR-0007. Both are **deferred** until a concrete need;
  each would be a separate decision, not a part of this one. The evidence itself is T59.
- **The research never starts an implementation** (a property of code, not of instruction): a
  `kind: research` never reaches the work-run path and never reads or writes `aiRun` (§6).

### R7. The handoff of a research (T49, T51)

`GET /tasks/:id/checks/:n/handoff` has a branch for `kind: research`. It holds the snapshot of the
pinned version, the list of documents, the comment as the person's **focus** (in a fence, with the
rule that it narrows what the agent looks at and cannot lift the rules), the rules and the report
format with the Markdown.

- **It is not generated from the workflow steps** (ADR-0028): `renderWorkflowSteps` is not called,
  so `editCode: true` cannot allow edits. Only `reportLanguage` applies, as in §6.
- The rules are those of §6: no change to the files of the project, no git command that writes, no
  write to the board but the report. This is instruction (R6).
- The handoff is computed on each request and stored nowhere.

### R8. Research that never ends (D7, T53)

A research whose session died stays `working` (§6 already says this of a check). **It is not
moved to a final state because of its age** (the principle of ADR-0029 T45: age is not evidence).
There is **no `abandon` route** for it and **`claude --recover` is not extended** to research. It
blocks nothing, and the page says plainly that it has no report. A late report is still accepted
while the research is `working`.

### R9. Routes, errors, events

- **New:** `GET /tasks/:id/checks/:n/report.md` (R3), not given to agents.
- **Extended:** `POST /tasks/:id/checks` (runner) accepts `kind?` and `comment?`;
  `POST /tasks/:id/checks/:n/report` takes the Markdown for a research and `targets?` for a
  recommendation; the check summaries carry `kind?`. `POST …/decisions` and `PATCH` with
  `fromCheck` are unchanged.
- **No new error code** (T50): `409 CHECK_ALREADY_FINAL`, `422 INVALID_CHECK_REPORT` and
  `409 CHECK_NOT_REPORTED` are used. The event stays `check.updated`.
- Every Research route is left out of the agents' instructions of an implementation.

### R10. Compatibility

- **No migration.** All fields are optional; existing checks are read as actuality checks;
  `formatVersion` stays 3 (D8).
- **An earlier board** reads a record with the new fields as a read issue (ADR-0022, strict
  schemas) and does not overwrite it. The number is not reused, because numbers count the names of
  files, including those that cannot be read (§2).
- **An earlier runner** is handled at the request, not here: ADR-0029 (D13).

### Consequences of the amendment

- Testable in the storage conformance suite: a begin with and without `kind` reads; numbers run
  through both kinds; `report.md` is written before `report.json`; the same bytes continue and
  other bytes are `409`; a `report.md` without metadata is not a report; it is absent from
  `listDocuments`; `deleteTask` removes it.
- Testable in the API: research and check of one task are numbered in turn and the second does not
  replace the first; a comment stays with its own begin; the limits answer as above.
- A research that is never ended stays in the list as `working`. That is the price of not letting
  age decide.
- Read-only is as strong as the instruction and the person's reading of the evidence (R6).

### Not decided in this amendment

- **E2 and E3** (D3): deferred, see R6.
- **D4-b and D4-c** (D4): not introduced, see R4.
- **D10** (T58): where the "Check actuality" button sits on the page. It is the interface of the
  page, not a rule of this ADR, and no closed Decision task decided it.
- The **limits of D12** are initial values, not measured.
