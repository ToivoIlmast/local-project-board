# ADR-0032: Topics, blocks and dependencies: readiness is computed, never stored

Status: accepted (2026-11-01). Not implemented: M1 Core, Board tasks
T80–T93. Where a work run on a blocked task is refused is the amendment T78 of ADR-0029 (rules
L1–L6). This ADR supplements the handoff contract of ADR-0028 (§8 below) and raises the
`formatVersion` of ADR-0009 (§10); neither of them is edited.

## Context

M1 tests three hypotheses of one developer's AI-assisted work, and this ADR holds the first two:

1. **Structure.** Topic → blocks → tasks helps keep the context and the order of a piece of work.
2. **A rule.** A blocked task is not handed to an agent.
3. **Checking what is affected** (M1 Revalidation) is decided separately (§11).

PHILOSOPHY §10 sets the rules and how little the board enforces; §2 makes topics, blocks and
dependencies optional; §9 rules out a workflow engine. This ADR is how those sentences are built.

Every rule names the owner's decision in brackets: the codes of the decision journal of the M1
plan (2026-11-01), from which the tasks T77–T101 were made.

## Decision

### 1. Optional

A task without `topic`, `block` and `dependsOn` works exactly as before: it has nothing to wait
for, its runs, handoff and checks are unchanged, and a board with no topics is the board of today
(PHILOSOPHY §2).

### 2. Ids

- **Topic `P<n>`, block `K<n>`**: global across the board, monotonic, never reused — ADR-0020 and
  its `allocateId` apply to them as to tasks (Q1).
- **The counters live in `.board/topics/sequence.json`**, not in `board.json`: an earlier version
  of the board writes `board.json` with the keys it knows and would drop them (Q1-S).
- **A topic or a block is created inside the storage's `exclusive()` section**: read the counter,
  `allocateId(max(counter, highest existing id))`, write `topic.md`, then write `sequence.json`
  through a temporary file and a rename. A missing `sequence.json` is recovered from the ids that
  exist.
- **Fail-closed (O-1).** If `sequence.json` is missing or invalid **and** at least one `topic.md`
  cannot be read, creating a topic or a block is refused with an error that says why, because a
  reused id cannot be ruled out; the rest of the board works. With a valid `sequence.json`, an
  unreadable topic does not stop creation. The code and status of this error are the contract's
  (T80).
- **The server does not start when `tasks.idPrefix` is `P` or `K`** (ADR-0021): `K3` would also
  match the task id pattern of `core/rules/ids.ts`.

### 3. Storage

- **A topic is `.board/topics/P<n>/topic.md`**: title, body and the **ordered** list of its blocks
  (`id`, `title`). It has no `status` field (O-4). Unknown frontmatter fields are kept, and a file
  that cannot be read is reported in `readIssues` (ADR-0022), never dropped or rewritten.
- **A task gains three optional fields**: `topic?: P<n>`, `block?: K<n>` (only together with
  `topic`, and the block belongs to that topic) and `dependsOn?: TaskId[]` (ids of tasks in the
  form of `tasks.idPrefix`). They are not content (ADR-0030 §1): changing them makes no version.
  An earlier version of the board keeps them in `extra` and writes them back.
- **The `Storage` port gains topics**, and its conformance suite grows with it (ADR-0004).

### 4. Writes

- **Topics** (T84): a topic can be created and edited. It can be deleted **only when it is
  empty**: no tasks and no blocks; an empty block makes a topic non-empty.
- **Blocks** (T84): a block can be created, renamed and reordered. It can be deleted **only when
  it has no tasks**.
- Deleting a topic or a block that is not empty is refused with `409` and changes nothing.
- There is no move of a block between topics.
- Every change is published as a `topic.*` event.
- **Task fields** (T85): `POST` and `PATCH` of a task refuse with `422`, writing nothing, a
  `dependsOn` that names a task that does not exist or a block id, a dependency cycle, and a
  `block` of another topic.
- The codes of these errors are the contract's (T84, T85); this ADR fixes what is refused and the
  status.
- Writes are last-write-wins (ADR-0018).

### 5. Done, blocks and their order

- **A task is done when its status is literally `done`** (Q7, D1). No other status counts as
  done.
- **A block is done when it has at least one task and all of its tasks are done** (a1, E2). There
  is no approval by the owner and no hash.
- **The blocks of a topic are in a line** (BL). A task of a block waits until **every** earlier
  block of its topic is done; reopening a task of a done block holds the blocks after it again
  (Q4-T1). An empty block is not done and holds the blocks after it (E2).
- **A task of a topic without a block is outside the order**: it neither waits for blocks nor
  holds them; only its own `dependsOn` apply (N1). A task without a topic likewise.

### 6. Dependencies

- **Direct only** (Q4-T2): a task waits for the tasks in its `dependsOn` to be done. A dependency
  that is done counts as done, whatever has since happened to the tasks it depended on.
- A dependency may be a task of another topic; it is shown as such.
- A task named in `dependsOn` that was deleted gives the reason `task-missing` (X1).

### 7. Readiness

- **`readiness` is one pure function in `core/rules`, re-exported by `contract/v1`** (ADR-0005,
  ADR-0006), so the server and the page compute the same answer. Its answer is a list of reasons,
  and an empty list means ready. **Nothing is stored**: a task is unblocked by the data changing,
  not by a write of its own.
- **The reasons are codes with parameters**; the client writes the text (Q10). There are eleven:
  - `task-not-done`, `task-missing`, `task-unreadable`: a task in `dependsOn` is not done, does not
    exist, or has a file that cannot be read;
  - `topic-missing` (no file) and `topic-unreadable` (a file in `readIssues`): the task's topic;
  - `block-missing`: the task's block is not in its topic;
  - `block-incomplete`, `block-empty`: an earlier block is not done, or has no tasks;
  - `block-order-unknown {tasks: [ID…]}`: a task file that cannot be read makes it unknown whether
    an earlier block is done. Only a task of a block that has earlier blocks gets this reason. A task
    of the first block of its topic, a task without a block, and a task without a topic never get
    it. See fail-closed below;
  - `cycle`: the task is in a dependency cycle. Writes refuse a cycle (§4), but a hand-edited file
    can make one;
  - `config`: see below.
- **Fail-closed.** When the board cannot tell whether a rule holds, the task counts as blocked
  (PHILOSOPHY §10):
  - **No `done` status in the board** → completion cannot be known. Only the tasks whose readiness
    depends on it get `config`: a task with a non-empty `dependsOn`, and a task of a block that has
    earlier blocks. A task with neither works as before, and so does the rest of the board (Q7).
  - **A task file that cannot be read** (a `readIssue` for `tasks/<ID>/task.md`) might belong to
    any block of any topic. So while there is one, whether a block is done cannot be known
    anywhere: tasks of a block that has earlier blocks, in every topic, get `block-order-unknown`.
    Tasks without a block, tasks of a first block (only their `dependsOn` apply), and tasks
    without a topic are not affected. When the file can be read again the reason is gone (C-2).
  - A missing or unreadable dependency or topic, a missing block, and a cycle: the reasons above.
- **`launchState`** sums a task up for the page: done, an AI run working, blocked, or ready to
  start. **Working and blocked can hold at once**: a task can become blocked while its run works,
  and that run is not stopped (Q4c). The page then shows both.

### 8. What the board enforces

- **The start of a work run.** `POST /tasks/:id/run` and begin refuse a blocked task with
  `409 TASK_BLOCKED` and its reasons; a check and a research are not refused. The rules are the
  amendment T78 of ADR-0029 (L1–L6).
- **The handoff — this supplements "Handoff (T15)" of ADR-0028**, whose route answers 200 or 404.
  `GET /tasks/:id/handoff` of a task with reasons answers **`409 TASK_BLOCKED`** with them,
  **unless the task's `aiRun.state` is `working`**: a run that has started, a resumed one
  included, always gets its handoff (H1, F1). The handoff of a check or a research
  (`GET /tasks/:id/checks/:n/handoff`) is not affected (Q4b).
- **`local-project-board handoff <ID>`** refuses in the same way, from the running board and from
  the files (F2):
  - When the running board answers `409 TASK_BLOCKED`, the CLI fails with the reasons and
    **does not fall back to composing the handoff from the files**. Today `printHandoff` falls back
    on any answer that is not 2xx, so a refusal would turn into a handoff; T88 changes that.
  - When no board runs, the CLI computes `readiness` from the files with the same function and
    refuses the same way.
- **"Copy handoff"** on the page is inactive for a blocked task without a working run, and shows
  why (F2).
- **`readiness` is read with the task, but it is not part of the task** (F3).
  - `taskSchema` gains only the three optional fields of §3: `topic`, `block` and `dependsOn`.
  - `readiness` is not added to `taskSchema`, to the storage or to the export. It is not written
    anywhere, and a `PATCH` cannot write it.
  - `GET /tasks` and `GET /tasks/:id` answer with a separate response schema: the task as
    `taskSchema` describes it, together with its `readiness`.
- **The instructions for agents state the rule** (Q4e). For an agent it is information, not a
  gate.
- **The owner can always act by hand.** On the page, changing the status of a blocked task asks
  for confirmation and shows the reasons. Moving a task between topics or blocks asks for
  confirmation and shows the old and the new place and what changes for readiness and the order
  of blocks. Reordering cards inside one block asks nothing (O-2).

### 9. What the board does not promise

The refusals are a guard, not a wall (PHILOSOPHY §10). The board does **not** promise:

- **To stop an agent that holds the token.** The board has one session token (ADR-0008), and the
  server cannot tell the owner from an agent. An agent that has it can read a blocked task, work on
  it, and change any task through the API.
- **To stop a run that has started.** It keeps going and keeps its handoff.
- **That begin is atomic with changes of other tasks.** Begin holds the lock of its own task only
  (the per-task lock of T45). Readiness is computed from the other tasks as begin reads them; a
  change of a dependency, or of a task of an earlier block, at the same moment is not ordered with
  it. A task is checked against what begin read, not guaranteed ready at the instant the run
  starts.
- **To confirm a manual change anywhere but on the page.** `PATCH` of a status, a `block` or a
  `dependsOn` asks for no confirmation: the server cannot tell who sends it. An agent with the
  token changes them without a warning.
- **To release a handoff held by a stuck run.** A run whose runner died stays `working`, and by F1
  its handoff stays available while the task is blocked. This lasts until the run is ended, or is
  recovered with `claude --recover` or abandoned (ADR-0029, T45). Nothing times it out: the age of
  a run is not evidence (T45).
- **To guard an earlier version of the board.** It keeps the fields in `extra` and applies no
  gate: it will start a blocked task.
- **To prevent edits of the files.** A hand edit, with the server running or not, is the owner
  acting by hand; the board sees its result on the next read (ADR-0019) and asks nothing.

### 10. Export

`formatVersion: 4` (Q11b). It holds the tasks with their new fields; the topics, with title, body,
unknown frontmatter fields and their ordered blocks with ids; and the counters of `sequence.json`.
So a backup never refers to a topic or a block it does not hold. A v3 export is still read. No
import is added: ADR-0009 stands, with its version raised here.

### 11. Not decided here

- **M1 Revalidation** is decided with its own task, T95: `doneAt`, the trigger of a check, its scope
  and the compatibility of runners. That task amends ADR-0030 and ADR-0029.
- **Deferred:**
  - approval of a block;
  - `dependsOn` between blocks;
  - the meaning of cancelled statuses, and `tasks.doneStatus`;
  - transitive blocking;
  - an automatic queue;
  - archiving a topic and deleting a topic that is not empty;
  - moving a block between topics;
  - i18n.

## Consequences

- **Readiness reads the whole board.** Every answer that carries it reads all tasks and topics
  from disk (ADR-0019).
- **Deleting a task that others depend on is not refused.** Its dependants get `task-missing`
  until the owner edits them.
- **One unreadable task file holds the later blocks of every topic** until it is fixed (C-2). That
  is the price of not guessing.
- **On a board without `done`**, only the tasks that depend on completion are blocked.
- **Refusals of begin are seen only in the terminal until T94.** A runner of today throws before it
  spawns `claude` when begin is not 2xx (`beginRun`, T33), so `claude` is not started. Until T94
  (T76-B3/C1), its refusal is seen in the runner's terminal and not on the page. T86 holds the
  first part with a test.
- **This ADR is ahead of the code until T80–T93 are done.** For example, the CLI handoff still
  falls back to the files (§8) until T88.
