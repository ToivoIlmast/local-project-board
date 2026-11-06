# ADR-0029: Claude Code is started by the CLI in the user's terminal, never by the server

Status: accepted (2026-09-26)

## Context

T19 is the first integration of the board with a concrete agent: from a task, one action starts
Claude Code on it. Two places could start the process. The board's server could, as the answer to
a route; or the person's own terminal could, through the CLI.

A route that starts programs turns the session token into the right to run code on the machine
(ADR-0008), whatever the route is careful about. Claude Code is also interactive: it needs the
terminal of the person, and a background server has none to give it (and WSL, Windows and macOS
differ in how one would even be opened).

Claude Code already has what is needed: `claude "<prompt>"` starts a new session in the current
directory with that prompt. It takes the model and the permissions from the user's own settings.

## Decision

- The **server never starts a process** for an agent. There is no route for it, and none is added
  without a new ADR that replaces this one.
- **`local-project-board claude <ID>`** does. It checks that the id is a task id, that a board is
  running for this project (`.board/runtime.json`, ADR-0024), that the board has the task and that
  `claude` is in the PATH; then it starts `claude` with `spawn`, no shell, one argument, in the
  root of the project, with the terminal of the command (`stdio: inherit`), and ends with the exit
  code of the session.
- **The argument is a prompt that points at the live handoff**, not the handoff:
  `claudeCodePrompt(id, boardUrl)` in `contract/v1`, the one function both the CLI and the page
  use. The agent reads `GET /tasks/<id>/handoff` itself, so the text is never stale, never has to
  fit a command line and never has to be quoted. The prompt holds no token: the handoff tells the
  agent to ask the board for one, as for any client (ADR-0008 amendment).
- **The page** offers "Send to AI → Claude Code — copy command": it copies
  `claude "<that prompt>"`, for a terminal in the project. It does not pretend to start anything.
- **Nothing is configured.** The board passes no flags to `claude`: the model, the permission mode
  and the rest are the user's Claude Code settings. A second, independent way to choose a model
  would disagree with them; the AI workflow settings (ADR-0028) are about how an agent works on a
  task, not about which agent it is. _(The model is amended by T35 below; the rest stands.)_
- **No registry of agents.** `AGENT_TARGETS` in the page and one command in the CLI; an
  abstraction waits for a second real agent (PHILOSOPHY §8).

## Consequences

- One step stays with the person: pasting the command, or typing `npx local-project-board claude
<ID>`. That is the price of a server that cannot run code.
- The session starts in the root of the project, that is the main worktree's directory when the
  command is typed inside a linked worktree (ADR-0001). A worktree per task is future work.
- The agent needs a way to make HTTP requests to `127.0.0.1` (Claude Code's `curl` through its
  Bash tool asks for permission by default).
- On Windows only a `claude.exe` is found: a `.cmd` cannot be started without a shell.

## Amendment (T27, 2026-09-26): Send to AI starts the session through a runner

The copied command left the click without an effect: nothing connected "Send to AI → Claude Code"
in the page to a process on the machine, so the person still had to paste. The decision above
stands — the server starts nothing — and the gap is closed by a process the person starts:

- **`local-project-board claude --wait`** is a runner. It checks `claude` in the PATH and the
  running board before it waits (so the board never promises a start that cannot happen), then
  waits on **`GET /api/v1/runs`**: an SSE stream that only the holder of the session token may
  open, and that carries nothing but run requests.
- **`POST /api/v1/tasks/:id/run`** with `{"agent":"claude-code"}` is what the page sends. The body
  names an agent from a closed list of one; there is no field for a program, an argument, a
  prompt or a directory, and unknown fields are refused. The board checks that the task exists
  and hands `{type: "run.requested", taskId, agent}` to **exactly one** waiting runner, ending that
  runner's stream. No runner → `409 NO_AGENT_RUNNER`, with the two commands that help. Nothing on
  the board changes. Both routes are left out of the agents' instructions.
- The runner starts the session exactly as `claude <ID>` does — `startSession`: `claude` with the
  one prompt argument, no flags (so no `--continue` or `--resume`: every start is a new session),
  in the project root, with its terminal — and waits again when the session ends. While a session
  runs it is not waiting, so a second click is refused instead of queued. After a restart of the
  board it finds the board again through `runtime.json`.
- The page composes no prompt any more: `claudeCodePrompt` has one caller, the CLI.
- **The result comes back through the API every agent already uses:** the task field `aiRun`
  (`agent`, `state`, `checks`, `commit`, `startedAt`, `finishedAt`; the branch stays
  `task.branch`, the report stays `report.md`) is written with `PATCH /tasks/:id`, and the handoff
  tells every agent to record its run. It is the agent's self-report; the page shows it as such.
  The card line and the check of `commit` against git are left to T20.

What this costs: a second terminal with the runner, started by hand once. What it does not change:
the server has no module that can start a process (a test lists the ones that can: the CLI's
`claude.ts` and `openBrowser.ts`, and the read-only git reader).

## Amendment (T31, 2026-09-28): Runner owns the aiRun lifecycle; begin/end routes added

T30 showed that a runner can lose the ability to write (the Bash tool was auto-declined), leaving
the task permanently in `aiRun.state: working`. This amendment gives the runner two dedicated
routes that the board updates independently of the agent's self-report.

- **`aiRun` gains runner fields** (`runId`, `sessionId`, `mode`, `model`, `failure`, `endedAt`)
  that the runner, not the agent, fills in.
- **`runId`** is a monotonically increasing integer per task, assigned by `POST
  /tasks/:id/ai-run` (begin). It identifies the current run and lets both begin and end be
  idempotent-safe.
- **`POST /tasks/:id/ai-run`** (begin): the runner calls this when the session is starting.
  The server assigns `runId = prevRunId + 1`, writes `state: working`, and records `sessionId`,
  `mode` and `model`. If `state` is already `working`, the server refuses with 409
  `AI_RUN_IN_PROGRESS`.
- **`POST /tasks/:id/ai-run/:runId/end`** (end): the runner calls this when the process exits.
  The `runId` must be the current one or the server refuses with 409 `STALE_AI_RUN`. If the
  agent has already written a final state (`finished`, `failed`, `needs-review`), the end call
  does not overwrite it — it only adds `endedAt` and, if non-zero, the exit code. If the agent
  never wrote a final state (stuck `working`), the server records `failed{exit}` or
  `failed{launch}`.
- Both routes are **not given to AI agents** in the generated instructions.
- **Legacy `aiRun` records** without `runId` (T20, T28, T29, T30) are read fine; the absence
  of `runId` is treated as `runId: 0` when computing the next `runId`. The files are not
  rewritten.

## Amendment (T35, 2026-10-06): the model is a parameter of the run

"Nothing is configured" is replaced for the model only. A run may name one; the permission mode,
effort and the rest stay the user's own settings.

- **The model is a parameter of the run, not of the workflow** (ADR-0028): it is not stored with
  the board or a column, only in `aiRun.model` of the run that used it.
- **`model?` in `POST /tasks/:id/run`** and in the `run.requested` request the runner receives.
  The value has a **closed form**: an alias from the short list `opus`, `sonnet`, `fable`,
  `haiku`, or a full name matching `^claude-[a-z0-9.-]+(\[1m\])?$` of at most 64 characters. It
  cannot begin with a dash, hold a space or a `;`. Anything else is refused with `400
  INVALID_REQUEST` before a runner is asked, like any other body that is not this route's. The
  board keeps **no list of full names**: they change with Claude Code, and `claude` refuses one it
  does not know (the run ends as `failed{exit}`).
- **No field means the default**: the runner passes no `--model`, and Claude Code uses the user's
  settings. `claude <ID>` has no model.
- **The runner passes `--model <model>` as two elements of argv** — never `--model=…` and never
  through a shell — ahead of `--session-id`, so that the prompt stays the last argument. Begin
  records the same value as `aiRun.model`.
- The closed form is what keeps the argv safe: the one value of a request that reaches a program
  is checked against it by the contract (a test lists the values that must fail).

## Amendment (T36, 2026-10-07): Resume continues the session of the last run

- **`mode?: 'new' | 'resume'` in `POST /tasks/:id/run`** (absent means `new`; `restart` comes later).
  A `resume` request is checked **by the board before any runner is asked**: the last run must
  have a `sessionId` (else `409 NO_SESSION_TO_RESUME`; a legacy run without one lands here) and
  must not be `working` (else `409 AI_RUN_IN_PROGRESS`). The request carries no session: the
  runner reads it from the board, so a client cannot name a session of its own.
- **`run.requested` carries `mode: 'resume'`** only for Resume; for `new` the event is unchanged.
- **The runner starts `claude [--model <m>] --resume <sessionId> <continuationPrompt>`**, in the
  root of the project, without a shell. It begins a new run (`runId + 1`, `mode: resume`) with the
  **same** `sessionId`; `begin` itself refuses `resume` with a session other than the last run's.
- **`continuationPrompt(taskId, boardUrl)`** sits beside `claudeCodePrompt`: the same checked id
  and loopback address, no token, "re-read the handoff and follow it".
- Not used: `-c/--continue` ("the last session in the directory" is ambiguous) and
  `--fork-session`.
- Kept by Resume: the branch, the commits, uncommitted changes and `report.md`; the board does not
  touch them. Sessions of Claude Code belong to the project directory, and the runner always starts
  in the root, so a session begun by this runner is found again.

## Amendment (T45, 2026-10-11): a run whose runner died is recovered by the CLI, on proof

T37 was left `working` for good: its runner ended without an `end`, and Resume and Restart both
refuse a run that works. The only way out was to edit `task.md` by hand, past every check.

- **The server still looks at no process.** Whether a run is alive is a question about this
  machine, so it is answered by **`local-project-board claude --recover <ID>`**, the person's own
  command, by reading `/proc` and nothing more: no signal is sent and nothing is stopped. The
  board only learns the answer.
- **The verdict is `alive`, `lost` or `unknown`**, and only `lost` changes the board without a
  word from the person. `lost` needs proof: the runner's journal of this run, on this host and in
  this PID namespace, whose runner and `claude` are both gone — identified by pid **and start
  time**, so a reused pid is not taken for them — or a boot since the run began; and no process
  of this user that holds the session (`--session-id`, `--resume`, `-r`, as two arguments or as
  `flag=value`; a substring of a command line is not enough). No `/proc`, another OS, another
  namespace or host, no journal, a process that cannot be read: `unknown`. Only then may the
  person add **`--confirm-stopped`**, and the run records that it was their word. A process that
  is seen alive is never overridden. **The age of a run is not evidence**; a long session is not a
  lost one, and nothing polls, beats or leases.
- **`POST /tasks/:id/ai-run/:runId/abandon`** `{sessionId, message}` is the board's half: a
  compare-and-set on runId, session and `working`. It writes `state: failed`,
  `failure: {kind: lost, message}`, and keeps `runId` and `sessionId`, so Resume continues the
  session as the next run (`runId + 1`). A stale runId or another session → `409 STALE_AI_RUN`; a
  run that is over → `409 AI_RUN_ALREADY_FINAL`; nothing is written either way. Not given to
  agents.
- **The runner keeps a journal**, `.board/runner/<ID>-<runId>.json` (untracked, owner-only, no
  token): who the runner and `claude` are, and, when `claude` ends, how — written and synced to
  disk **before** the board is told. Memory is not enough: the case to cover is a runner that
  died. The runner retries `end` for ~30 s and looks the board up afresh each time (a restarted
  board has another address and token); an end it could not deliver stays in the journal and is
  delivered by the next `claude --wait` (on every connection), `claude <ID>` or `claude --recover`.
  A journal whose run the board has replaced is dropped.
- **The lifecycle is serialized per task**: begin, end, report, abandon and the checks of
  `POST /run` read and write the run under one lock, which the task service shares for
  `PATCH {aiRun: null}`. Two begins at once make one run. Every change of the lifecycle is
  published as `task.updated`.
- **`end` names its session** (`sessionId`, and `endedAt` when delivered late); an end of another
  session is `409 STALE_AI_RUN`. It is optional only for runners of an earlier version. A late
  end or report of an abandoned run cannot touch the run that replaced it (another runId), and a
  late end of the abandoned run itself keeps `failed{lost}`.
- **`POST /tasks/:id/run` refuses `409 AI_RUN_IN_PROGRESS` while a run works, for every mode**,
  before a runner is asked (T36 did it for `resume` only).
- **`PATCH /tasks/:id {"aiRun": null}` is refused for any run with a runId**, working or over
  (`409 AI_RUN_NOT_CLEARABLE`; nothing is written). Clearing it would hide a live run, or start
  runId again from 1 — and then a late end or report of the cleared run would name a runId the
  new run has too. The session check of `end` does not make that safe: a resumed run keeps the
  session, and `end` without a session and `report` check none. Such a run is replaced by the
  next one instead, and a lost one is ended by abandon. A run an agent reported itself before
  T31 (no runId) has no numbering to keep and may still be cleared that way.

## Amendment (T46, 2026-10-17, accepted with ADR-0030; implemented by T46): an actuality check is a run of its own kind

The server still starts nothing. `POST /tasks/:id/run` gains `kind?: 'work' | 'check'`, absent
meaning `work`, and `run.requested` carries `kind: 'check'` only for a check. The CLI gains
`claude <ID> --check`. A check is always a new session and is not refused while a work run is
`working`. The runner begins and ends it through the check routes (`POST /tasks/:id/checks`,
`…/checks/:n/end`), not the aiRun routes.

Its journal is kept apart from the journals of work runs: `.board/runner/<ID>-check-<n>.json`,
with a schema of its own (`kind: 'check'`). The work-run journal (`<ID>-<runId>.json`,
`formatVersion: 1`) and its strict schema are unchanged. So `listJournals`, `deliverEnd`, the
`replaced` rule and `claude --recover`, in this version and in earlier ones, skip a check journal
and never deliver it to an aiRun route. The end of a check is retried as T45 does, and its
journal is dropped on `2xx`, `404` or `409`. `--recover` is not extended.

The agent reads `GET /tasks/:id/checks/:n/handoff`, which pins one version of the task and
forbids writes, and reports through `…/checks/:n/report`. A check never reads or writes `aiRun`.
Details in ADR-0030 §6.

## Amendment (T54, 2026-10-24, partly accepted 2026-11-02): Research is a run of its own kind

Status of this amendment: **partly accepted** (2026-11-02): set A of the partial acceptance below
is **accepted**; every other rule is **proposed**, and the owner sets `accepted`. The rules of what
a Research is, how it is stored and what it promises about read-only are in ADR-0030 (amendment of
T54); this one holds only how it is requested and started. The server still starts nothing. Each
rule is the owner's decision in a closed Decision task (in brackets). No ADR-0031 is created (D5,
T54).

**Partial acceptance (owner, 2026-11-02).** The owner accepted set A below by a separate decision,
taken before the audit of T54 (T79) is finished. Every rule of this amendment not named in set A
stays proposed. The text of the rules further down is unchanged.

- **Set A, accepted:**
  1. `kind: 'research'` in `POST /tasks/:id/run`: the lead of the first rule.
  2. The sub-rule "Like a check, a research is not refused…", whole: a research is not refused
     while a work run is `working`, nor while another check or research is; it never reads or
     writes `aiRun`, and it never reaches the path that starts a work run.
  3. In the sub-rule on `run.requested`: the event carries `kind: 'research'` for a research. The
     field `comment?` of the same sub-rule is in set B.
  4. The rule on D13 (T53), whole: the closed form of `accepts`; a runner without `accepts` is
     taken to accept `work` only; a request is handed only to a waiting runner that accepts its
     `kind`; `409 NO_AGENT_RUNNER` when there is none, and nothing on the board changes; no
     acknowledgement; the gap for `kind: 'check'` is closed.
- **Set B, still proposed:**
  - `comment?` and its limits;
  - the rule that a research takes no `mode` but `new`;
  - the passage of the comment through the runner into `begin`, and its absence from `argv` and
    the environment of `claude`;
  - `researchPrompt`;
  - the CLI `claude <ID> --research [--comment …]`;
  - what the rule on the runner's journal adds to §6 of ADR-0030: the journal records no comment,
    and no `abandon` route is added;
  - the flags of access rights;
  - "Not given to agents";
  - the line "What this costs".
- **The journal of checks and research.** The shared mechanism is accepted through the first point
  of R1 of ADR-0030 (set A there), not through this amendment: a research uses the check journal
  `.board/runner/<ID>-check-<n>.json` of T46 with the rules of ADR-0030 §6, and has no journal
  namespace of its own. What §6 says of a check therefore holds for a research, as a consequence of
  that point and not as a rule of this amendment: `claude --recover` reads only the journal of a
  work run, by its integer name, so it does not read the journal of a research; and a research
  that never ends stays `working` and is shown as having no report. The rule on
  the runner's journal below repeats this in its first sentence and in its sentences on
  `claude --recover` and on a research whose runner died; those hold through ADR-0030 R1 and §6.
  What the rule adds beyond §6 is in set B: the journal records no comment, and no `abandon` route
  is added. Set A changes neither the schema nor the rules of the journal.
- **What set A changes for a check.** D13 applies to every kind, not to research alone. A runner
  that sends no `accepts` is taken to accept `work` only, so it is no longer handed a check; while
  no waiting runner accepts `check`, a check request is answered `409 NO_AGENT_RUNNER`. A runner
  that is to take checks has to send `accepts` with `check`, and existing runners may need an
  update.
- **T78, L6.** "Everything else in this ADR stands" in L6 says that T78 does not change the rules
  of the research; it does not accept the amendment of T54, and it does not change the status of
  any of its rules. What of T54 is accepted is set A, by this decision.
- **If the code differs.** If the audit of T79 finds that the code differs from set A, the code
  is corrected to set A; set A is not changed to fit the code.

- **`POST /tasks/:id/run` gains `kind: 'research'`** beside `work` and `check` (D1, T49).
  - **`comment?` is allowed only with `kind: 'research'`**; with another kind it is refused with
    `400 INVALID_REQUEST`, as `mode` is for a check. It is a non-empty string without NUL of at
    most **4 000 characters** (D12, T50); anything else is `400 INVALID_REQUEST` **before a runner
    is asked**. A research takes no `mode`, or only `new`: it is always a new session.
  - Like a check, a research is not refused while a work run is `working`, nor while another
    check or research is. It never reads or writes `aiRun`, and it never reaches the path that
    starts a work run.
  - **`run.requested` carries `kind: 'research'` and `comment?`** only for a research; for `work`
    and `check` the event is unchanged.
- **The comment travels through the runner into `begin`, and never into `argv` or the environment
  of `claude`.** The runner calls `POST /tasks/:id/checks` with `{agent, sessionId, model?, kind,
  comment?}`, and the comment is stored in the begin record (ADR-0030 R2). The board keeps no
  pending request between the click and the begin, so a restart of the board loses nothing it
  held. The agent reads the comment from the handoff, as the person's focus that narrows what it
  looks at and does not lift the rules.
- **`researchPrompt(taskId, n, boardUrl)`** in `contract/v1`, beside `claudeCheckPrompt`, is the one
  argument the runner gives `claude` for a research. Its **form is closed**: the checked task id,
  the check number and the loopback address, and nothing else; no comment, no token, no free text.
  The runner starts `claude [--model <m>] --session-id <uuid> <researchPrompt>` in the root of
  the project, without a shell, in two elements for `--model` as in T35, and the prompt stays the
  last argument. The comment is not escaped anywhere, because it reaches no command line.
- **The CLI gains `local-project-board claude <ID> --research [--comment <text>]`.** The text goes
  into the JSON body of `begin`. It is checked by the same rule as the route. The form of
  `--comment-file` is **not** part of this decision.
- **The runner's journal is the check journal** `.board/runner/<ID>-check-<n>.json` of T46, with
  its isolation, retry and dropping rules unchanged. The journal records no comment. `claude
  --recover` is **not extended** to research (D7, T53): a research whose runner died stays `working`
  and is shown as having no report. No `abandon` route is added.
- **A runner of another version is not left to lose the request (D13, T53).**
  - The runner says which kinds it can start: **`GET /api/v1/runs?accepts=check,research`**,
    a query parameter of closed form (a list of kinds from `check` and `research`). **Without
    it the runner is taken to accept `work` only**, as every runner before this amendment does;
    `work` is accepted by every runner.
  - The board hands a request only to a waiting runner that accepts its `kind`. If there is
    none, the answer is **`409 NO_AGENT_RUNNER`** with the plain instruction to update the runner
    (the existing code; no new one), and nothing is changed on the board.
  - There is **no acknowledgement** of the request by the runner: no ack route, and no wait of
    the page for one. The request is handed to exactly one runner, as before.
  - This closes the gap that exists today for `kind: 'check'` with a runner older than T46, whose
    stream ends on an event it does not know.
- **Flags of access rights are not passed.** "The board passes no flags to `claude`" stands except
  for `--model` (T35) and `--session-id` (T31). The permission flags that were considered for a
  read-only session (E2) are **deferred** (D3, T51); if chosen later, that is a separate decision
  that amends this ADR for a research alone.
- **Not given to agents:** the research routes and the `accepts` query are left out of the
  instructions an agent of an implementation reads.

What this costs: a runner of an earlier version has to be updated before the first research. What
it does not change: the server has no module that can start a process, and a research does not
touch the work-run lifecycle.

## Amendment (T78, 2026-11-01, accepted): a blocked task is not started

Status of this amendment: **accepted**. What makes a task blocked —
`readiness` and its reasons — is ADR-0032; this amendment holds only where a work run on a
blocked task is refused. The server still starts no agent. The rules are numbered L1–L6, apart
from the V-rules of the later amendment for the trigger of a check (T95). The codes in brackets
are the owner's decisions, as in ADR-0032.

- **L1. `POST /tasks/:id/run` with `kind: work` refuses a blocked task in every mode: New, Resume
  and Restart** (G1). Restart (T37: `mode: 'restart'`, `409 NO_RUN_TO_RESTART`) is in the code
  but has no amendment of its own in this ADR; it is named here, not described. The refusals come
  in the order of the code, and the gate takes one place in it (F4):
  1. `400 INVALID_REQUEST` for the body, and `404 TASK_NOT_FOUND`;
  2. `409 AI_RUN_IN_PROGRESS` while a run works, for every mode (T45);
  3. `409 NO_SESSION_TO_RESUME` for Resume (T36), `409 NO_RUN_TO_RESTART` for Restart (T37);
  4. **`409 TASK_BLOCKED`**, with the reasons of ADR-0032;
  5. `409 NO_AGENT_RUNNER`.

  `TASK_BLOCKED` comes before `NO_AGENT_RUNNER` because the board learns that no runner waits only
  by handing the request: the dispatcher looks for a waiting runner and, if one waits, sends it
  `run.requested` in the same step. A refusal after it would come after a runner had been told. On
  `TASK_BLOCKED` nothing is written, no runner is asked and no `runId` is allocated; for Resume
  the session stays the last run's, and Resume continues it once the task is ready (G1).
- **L2. Begin (`POST /tasks/:id/ai-run`) refuses a blocked task too: it is the last guard on the
  server** (Q4-P). Every work run passes begin, `local-project-board claude <ID>` included, which
  does not go through `/run`. The check runs under the lock of the task (T45), after the checks
  begin already makes (`400 INVALID_REQUEST` for the body, `404`, `AI_RUN_IN_PROGRESS`,
  `NO_RUN_TO_RESTART`, `NO_SESSION_TO_RESUME` for a session that is not the last run's) and
  before anything is written: `409 TASK_BLOCKED`, no `runId` allocated, `aiRun` unchanged. A task
  that became blocked between `/run` and begin is refused at begin. Readiness is computed from
  what begin reads at that moment; the lock is only this task's, so a change of another task at
  the same moment is not ordered with it (ADR-0032 §9).
- **L3. A check and a research are not gated** (Q4b), so a blocked task can still be checked or
  researched. Their operations are unchanged:
  - the request: `POST /tasks/:id/run` with `kind: 'check'` or `kind: 'research'`;
  - the begin: `POST /tasks/:id/checks`. This is one route for both, told apart by `kind` in its
    body (absent for a check, `'research'` for a research; T46, T54). It never touches `aiRun`;
  - the end, `POST /tasks/:id/checks/:n/end`, and the report, `POST /tasks/:id/checks/:n/report`.
- **L4. A run that has started is not stopped** (Q4c). A task that becomes blocked while its run
  works keeps that run: `end`, `report` and `abandon` are accepted as before, and the run keeps
  its handoff (ADR-0032 §8).
- **L5. In the protocol between the board and the runner, the only change is `409 TASK_BLOCKED`
  as an answer of begin.** That protocol is `GET /runs` with its `accepts` query, the
  `run.requested` event, and the lifecycle routes the CLI calls: begin, end and abandon of a work
  run, and begin and end of a check. No field is added to any of them.
  - `/run` is the page's route, not the runner's, so its new answer is not part of this protocol.
    A refusal of `/run` is seen on the page.
  - For Resume the CLI also reads `GET /tasks/:id`. That answer gains `readiness` and the
    optional fields of ADR-0032, but the CLI uses only `aiRun` from it, so it stays compatible.
  - A runner of an earlier version fails before it spawns `claude` when begin is not 2xx (T33),
    so `claude` is not started. Until T94 (T76-B3/C1), that refusal is seen only in the runner's
    terminal.
- **L6. Everything else in this ADR stands**:
  - the server starts no agent;
  - a request is handed to exactly one runner, and `NO_AGENT_RUNNER` is answered when none can
    take it;
  - the lifecycle of runs (T31, T45), Resume (T36), the check (T46) and the research (T54).

What this costs: nothing new to run or configure. What it does not give:

- An earlier version of the board applies no gate.
- The gate is on the start of a run, not on the task. An agent that holds the token can still
  read the task, work on it and change tasks through the API (ADR-0008, ADR-0032 §9).

## Amendment (T94, 2026-11-06, accepted): a refused start of a work run is reported to the board

Status of this amendment: **accepted** (2026-11-06). The owner chose, for T94 (B3/C1), a separate
signal from the runner to the board. The rules are numbered K1–K17. This amendment
replaces nothing above. For a **work** run only, it adds to:

- the rule of T27 "Nothing on the board changes": a request that is handed now writes `launch`
  (K5); a request that is refused still changes nothing;
- L5 of T78, the sentence "No field is added to any of them": the query `signals`, the field
  `requestId` of `run.requested` and the route `run-failure` are added (K8, K11);
- the last bullet of L5, "Until T94 … seen only in the runner's terminal": for a runner that
  declares `signals`, a refusal of begin is now also seen on the page (K9, K12).

**Why.** `POST /tasks/:id/run` writes nothing, and the board keeps no pending request. `200` means
"handed to one waiting runner" and nothing more. After that the runner can still stop before the
session starts. This can happen in three places, and the runner reports it only in its own terminal:

- `findClaude` finds no `claude` in the PATH (it was there when the runner began to wait);
- `sessionToResume` finds no finished session (Resume of a task that has none any more);
- `beginRun` is refused: `TASK_BLOCKED` (T78 L2), `AI_RUN_IN_PROGRESS`, `NO_SESSION_TO_RESUME`,
  `NO_RUN_TO_RESTART`, `400`.

The page says "Claude Code is starting …", and nothing follows. `end` cannot carry these failures:
it needs a run, and a run exists only after a successful begin.

- **K1. Scope: `kind: work` only.** A check and a research (T46, T54) are **not changed**:
  - their request has no `requestId`;
  - the board writes no `launch` for them;
  - the runner sends no `run-failure` for them;
  - their `/run` still uses `hand()` as before;
  - a start that fails is still seen only in the terminal.

  Nothing in K2–K17 applies to them.
- **K2. A request has an id.** `/run` of a work run makes a `requestId` (UUID v4) for each request it
  hands. The board makes the id; it is never taken from a body. The id is carried in `launch` (K3),
  and in `run.requested` only for a runner that declared `signals` (K11). **The answer of `/run` does
  not carry it:** `runStartedSchema` is unchanged. The page reads the request from the task (K12),
  and a page loaded from an earlier board parses that answer strictly.
- **K3. `launch` in the task.** This is one optional field, written only by the board:

  ```
  launch?: {                      // strict
    requestId: uuid,
    requestedAt: iso datetime,
    afterRunId: int >= 0,         // runId of the task's run when the request was made; 0 if none
    reports: boolean,             // the runner that took it declared `signals=run-failure` (K11)
    failure?: {                   // strict
      kind: 'claude-missing' | 'resume-refused' | 'begin-refused' | 'runner-error',
      message?: string,           // one line, 1–500 characters after cleaning (K10)
      at: iso datetime
    }
  }
  ```

  - It is stored in `task.md` as the frontmatter key `launch`, which is one more name in `KNOWN` of
    the task file. So it survives a reload and a restart.
  - **It is not content** (ADR-0030 §1): it makes no version, it is not in `contentHash`, and
    `contentOf` does not read it. `PATCH /tasks/:id` does not accept it, because the body is strict.
    It is not given to agents.
  - Like every write of the storage, a write of `launch` sets `updatedAt`, as a write of `aiRun`
    already does.
- **K4. When `launch` is current: one predicate, not a state.** A `launch` is *current* when both
  hold:
  - `currentRunId(task.aiRun) === launch.afterRunId`;
  - `task.aiRun?.state !== 'working'`.

  Otherwise it is *stale*.
  - A stale `launch` is shown as nothing (K12). `run-failure` refuses it (K8). Nothing acts on it.
    It stays in the file until the next request replaces it.
  - `runId` changes only through begin: `end`, `report` and `abandon` keep it, and `PATCH` can
    only clear an `aiRun` that has no `runId` (T45). So "a run has begun since this request" is
    exactly "`runId` has moved". This holds for every board version and every begin: `claude <ID>`
    and begins on an earlier board (K14) too.
  - There is no status field, no timer, no lease and no version marker. "Waiting" is a current
    `launch` without `failure` (T45: the age of a request is not evidence).
- **K5. Who writes `launch`, and nobody else does.**
  - **`/run` of a work run** writes it whole for each request it hands (K6). It replaces the
    previous `launch`, together with that request's failure.
  - **`run-failure`** adds `failure` once, to the current `launch` with the same `requestId` (K8).
  - **Begin removes it.** This happens in the same `updateTask` that makes `aiRun.state: working`
    (`{aiRun, launch: null}`, one file write), whoever calls begin. This keeps the file tidy;
    K4 already makes it stale.
  - Every other write of the task leaves it as it is. The storage reads and writes a task in one
    ordered section, and no other patch names `launch`.
- **K6. The order of `/run` for a work run: one action under the lock of the task.** The action
  runs under the same `TaskLocks` as begin, end, abandon and `run-failure` (T45):
  1. **The refusals of L1, in their order:** `404`, `AI_RUN_IN_PROGRESS`, then
     `NO_SESSION_TO_RESUME` / `NO_RUN_TO_RESTART`, then `TASK_BLOCKED`. The lock is not
     re-entrant, so these checks run inside the action and not as the public `require*`, each of
     which takes the lock again.
  2. **Reserve a runner.** The dispatcher takes one waiting runner that accepts work out of the
     waiting list, in one synchronous step. It records whether that runner declared `signals`. If
     none waits, the answer is `409 NO_AGENT_RUNNER`, and nothing is written.
  3. **Write `launch`** with a new `requestId`, `afterRunId` and `reports` of the reserved runner.
     The write either replaces `task.md` whole or fails and leaves it as it was (`writeFileAtomic`).
     If it fails, the runner goes back to the waiting list as it was, and the answer is `500`. No
     runner was told.
  4. **Send** `run.requested` to the reserved runner and end its stream. The event carries
     `requestId` only if the runner declared `signals` (K11).
     - If that runner's connection closed during step 3, nothing is sent. The previous `launch` is
       written back, and the answer is `409 NO_AGENT_RUNNER`.
     - If writing it back fails, the answer is `500`. `launch` then names a request that no runner
       holds, and the page shows it as in K12. This is the one case that needs two failures at
       once; see K17.
  5. **Publish `task.updated`, answer `200`, and release the lock.**

  A check and a research keep `hand()` (K1). The dispatcher splits "pick" and "send" only for work.
- **K7. What K6 guarantees.**
  - **I1.** A runner learns of request *n* only in step 4. By then `launch(n)` is on disk.
  - **I2.** All that runner then sends about *n* (begin, `run-failure`) arrives after step 4. It
    takes the same lock and so runs after the action of *n*. The lock is a promise chain in the
    order of the calls (`taskLocks.ts`), so the runner always finds `launch(n)` or what came after
    it, never what came before.
  - **I3.** No `launch` is written for a request that was refused. The one exception is the double
    failure of K6 step 4.
  - **I4.** Two `/run` of one task are serialized. Two `/run` of different tasks cannot take the
    same runner, because step 2 has no `await`.
  - **I5.** At most one `launch` is current per task, and it belongs to the last handed request.
- **K8. `POST /api/v1/tasks/:id/run-failure`: runner → board; not given to agents.**
  - **Auth:** the session token, as for every change (`Authorization: Bearer`, ADR-0008), and the
    Host/Origin checks. Without the token: `401 UNAUTHORIZED`.
  - **Body** (strict): `{requestId: uuid, kind: 'claude-missing' | 'resume-refused' |
    'begin-refused' | 'runner-error', message?: string}`. `message` is at most 500 characters on
    the wire; above that the answer is `400`.
  - **Under the lock of the task**, a compare-and-set:

    | State under the lock | Answer | Writes |
    |---|---|---|
    | `launch` current (K4), same `requestId`, no `failure` | `200 {recorded: true, launch}` | `failure`; `task.updated` |
    | current, same `requestId`, `failure` already there (any `kind` or `message`) | `200 {recorded: false, launch}`: the first accepted report wins; the answer shows the stored one | nothing |
    | no `launch`; another `requestId`; or `launch` stale (a run has begun since) | `409 STALE_LAUNCH_REQUEST` (new code; fixed text; only `{id}` echoed) | nothing |
    | task missing | `404 TASK_NOT_FOUND` | nothing |
    | body malformed | `400 INVALID_REQUEST` | nothing |

  - **It never reads a runner and never changes `aiRun`.**
- **K9. The runner reports, and only when nothing began.** For a request that carries a
  `requestId`, `claude --wait` sends `run-failure` when the start stopped **before `beginRun`
  returned 2xx with a run**. The four kinds are:
  - `claude-missing`: `findClaude` failed;
  - `resume-refused`: the board answered `sessionToResume`, and the answer has no finished session;
  - `begin-refused`: the board answered begin with a non-2xx, or with a body that is not a run;
  - `runner-error`: any other failure before a successful begin, including a board that did not
    answer.

  Then the runner waits again, as it does now, and the text still goes to its terminal.
  - **Two stages.** The start is split at the successful begin. For one request, at most one of
    "begin succeeded" and "`run-failure` sent" happens. A failure after begin is never reported
    this way.
  - **T33 stands:** begin comes before spawn, and `end` is always sent for a run that began. A spawn
    that fails after begin is still `end{launchError}`.
  - **A begin that was taken, whose answer was lost:** the report finds a stale `launch` (K4) and is
    answered `409`, so it is not shown as a failure.
  - **Delivery:** up to three tries, 500 ms apart, on a network error, a timeout or `5xx`. Before
    each try the runner looks for the board again in `runtime.json`, as `end` does (T45). A board
    restarted on the same `.board/` still holds `launch` and can take the report. `2xx`, `400`,
    `401`, `404` and `409` end the delivery. If the report is not delivered, the runner says so in
    its terminal, and the page keeps showing the request as in K12.
  - **No journal:** a journal serves a runner that may die (T45). This runner is alive and tells the
    person in its terminal.
  - `claude <ID>` has no request and sends nothing: its error is the answer in its own terminal.
- **K10. What a message may hold.**
  - **The runner composes `message`** only from fixed words of its own, or from the `message` of a
    board answer, which is fixed text with task and topic ids. It never uses the `error.message` of
    an exception, the environment, `argv`, the prompt, a path or the token (ADR-0008 T70). For
    `runner-error` the text is always "The runner could not start Claude Code; see its terminal."
    The runner cuts the text to 500 characters before it sends it.
  - **The board cleans the text** before it stores it:
    - control characters, newlines included, become spaces;
    - any occurrence of the session token becomes `[token]`;
    - the result is trimmed;
    - if nothing is left, no `message` is stored.
  - The body is never logged. The page shows the message as text, never as HTML.
- **K11. Compatibility is declared like `accepts` (D13), not by a version.**
  - **A runner declares it:** `GET /runs?accepts=check,research&signals=run-failure`. `signals` is a
    closed list (today one value), parsed strictly like `accepts`. A runner without it is of an
    earlier version.
  - **`run.requested` carries `requestId` only for a runner that declared it.** For any other
    runner, the event is exactly the old one. The `runRequestSchema` of an earlier runner is
    strict: a field it does not know makes the runner drop the event after the stream has ended,
    and the request would be lost while the page says "handed" (the gap D13 closed for `kind`).
  - **For an earlier runner, the board still writes `launch`, with `reports: false`.** That runner
    uses begin, end and abandon exactly as before, and it sends no `run-failure`.
  - **A newer runner with an earlier board:**
    - The earlier board answers `400 INVALID_REQUEST` to the unknown query name. Its query schema
      is strict, and it parses the query before it counts the runner as waiting, so nothing can
      have been handed.
    - The runner then asks again at once, without `signals`. It tells the person once: "This board
      is of an earlier version: it will not show a failed start on the page." It does not offer
      `signals` again to the board with that token, and it forgets this when it finds a board with
      another token.
    - This is one step, not a loop, and no request is lost.
    - Every other answer of `GET /runs` keeps today's handling. This amendment does not change it.
  - No `formatVersion`, no handshake route and no acknowledgement of the request are added.
- **K12. The page** reads `task.launch` and `task.aiRun`, and nothing else. It keeps no state of its
  own about a request (ADR-0025). Its cases are:

  | Board state | The page shows |
  |---|---|
  | `aiRun.state: working` | the existing display, and nothing of `launch`. Only this says that Claude Code has started. |
  | `launch` stale, or none | nothing about a request |
  | `launch` current, no `failure`, `reports: true` | neutral and static: "Sent to a runner at {time}. Claude Code has not begun, and the runner has reported no problem. The board cannot tell whether the runner is still there; if nothing begins, look at its terminal." |
  | `launch` current, no `failure`, `reports: false` | "Sent at {time} to a runner of an earlier version, which cannot report a failed start. If nothing begins, look at its terminal." |
  | `launch` current, with `failure` | "Claude Code did not start", then a text of the page for its `kind`, the runner's `message` as a detail, and the time |

  - No spinner, no "is starting", no elapsed-time judgement. A request without a report is never
    called a failure.
  - Start stays available in every case except `working`. A new request replaces `launch`.
  - The note after a `200` from `/run` says that the request was sent to a runner, not that Claude
    Code is starting.
- **K13. Races and repeats, as K4–K9 decide them.** Every case below runs under the lock of the
  task, in the order the actions took it.

  | Order | Result |
  |---|---|
  | `/run`(n) → `run-failure`(n) | recorded |
  | `/run`(n) → `run-failure`(n) → the same again, or with another `kind` or `message` | `200 recorded: false`; the first report stays |
  | `/run`(n) → begin (any caller) → `run-failure`(n) | `409`: a run has begun; the page shows it |
  | `/run`(n) → `run-failure`(n) → begin (a later request, or `claude <ID>`) | the failure is no longer current, because a run has begun since; begin removes it |
  | `/run`(n) → `/run`(n+1) → `run-failure`(n) | `409`; the page shows request n+1 |
  | `/run`(n) → `run-failure`(n) → `/run`(n+1) | the failure of n is replaced: it is no longer the last request |
  | begin → `/run` | `AI_RUN_IN_PROGRESS` while the run works; otherwise the new request has the new `afterRunId` |
  | `/run`(n) → end, report or abandon of the run before it | `launch` stays current: `runId` did not move |
  | `/run` on two tasks with one runner | one gets the runner, the other gets `NO_AGENT_RUNNER` (K7 I4) |

  - A runner sends `run-failure` for a request only after its own begin for that request has
    failed or was never made, and at most once per request (K9).
  - When `claude <ID>` begins while a request waits, begin removes `launch`. The handed runner is
    refused at begin (`AI_RUN_IN_PROGRESS`), reports, and gets `409`. Its text stays in its
    terminal.
- **K14. An earlier board on the same `.board/` (downgrade).** This is tolerated, not supported:
  an earlier board shows no request and no failure.
  - It keeps `launch` as an unknown frontmatter field (`extra`) and writes it back unchanged.
  - Its begin does not remove `launch`, but its begin moves `runId`. So when a board of this
    version reads the file again, the `launch` is stale (K4) and is not shown.
  - If no run began meanwhile, the `launch` is still current and is shown as it was. That is true:
    no run has begun since that request.
  - Its page never shows `launch`, so it shows no false "waiting".
- **K15. Export.** `launch` is a field of the task as stored, as `aiRun` is. A snapshot holds it in
  `tasks`, unchanged, and the snapshot stays `formatVersion: 4` (ADR-0032 §10: "the tasks with
  their new fields"). A stale `launch` in a backup means nothing, by K4. *(Owner decision Q4,
  2026-11-06: included, as the export contract of T87 says.)*
- **K16. Security.**
  - The route needs the token, takes a strict body, and keeps at most 500 cleaned characters. It
    never changes `aiRun`, never starts or stops anything, and is not given to agents.
  - `requestId` is not a secret: `GET /tasks/:id` shows it in `launch`. A holder of the token who
    reads it can mark a waiting request as failed. That holder can already change and delete the
    task (ADR-0008), so the route gives no right that the token does not already give. The worst
    effect is a failure shown for a request that may still begin; begin then removes it.
  - Tokens, prompts, `argv` and the environment reach neither the route, the stored field nor a log.
- **K17. What does not change, and what this costs.**
  - **Unchanged:**
    - the server starts nothing;
    - a request goes to exactly one runner;
    - end, abandon, report, the journals of T45/T46 and the gates of T78 are as they were.
  - **What changes:**
    - begin only also removes `launch`, in its one write;
    - `/run` of a work run becomes the one action of K6 and holds the lock for its checks (which
      read the whole board, ADR-0019) and one write.
  - **An earlier runner stays silent** (K11), and an earlier board shows nothing (K14). To see a
    failure, the board, the page and the runner have to be updated. None of them stops working
    alone.
  - **A page loaded from an earlier board** parses tasks strictly and does not accept a task that
    has `launch`, as for any new field of a task (T85). It has to be reloaded.
  - **The page shows a waiting request with nothing after it** when a report is not delivered, a
    runner dies after the hand, or the board restarts between the hand and begin. It says so
    honestly (K12) and never resolves it by itself. The next request or begin replaces it.
  - **K6 step 4 can leave a request that no runner holds.** This needs two failures at once: the
    runner's connection closes during the write, and the write back fails. The page then shows it
    as waiting, which is the same display as a runner that died.
  - A failed start of a check or a research is still seen only in the terminal (K1).

**Not chosen.**

- **Hand first, then write (v2).** After a failed write, a runner holds a request that the board
  has no record of. A stale `launch` of an earlier request can then stay on the page for a request
  that is running.
- **Write first, then `hand()` with undo.** `reports` is not known before a runner is chosen. "No
  runner" is the most common answer, so it would cost a write and an undo, and a failed undo would
  show a false "waiting". Between the write and `hand()`, another task can also take the only
  runner. K6 reserves before the write instead.
- **Handshake (the runner acknowledges a request).** It would say that a runner took the request,
  which the hand already says, and still not why it did not start. It needs an ack route and a
  timeout: a lifecycle of requests. The same `requestId` stays available to it later.
- **Existing `begin` + `end(launchError)`.** This would make a run for a session that never existed
  (`runId + 1`, an unused `sessionId`), and Resume would then refuse. It cannot carry
  `resume-refused` or `begin-refused`.
- **A version marker for downgrade.** `afterRunId` (K4) decides staleness from what every board
  version already writes.
- **A timeout on a waiting request.** Not allowed in T94 (T45: age is not evidence).
- **Fixing the endless reconnect of the runner for any non-2xx of `GET /runs`.** This is outside
  T94, and a separate task is proposed.

**Other ADRs (not changed here).**

- ADR-0030 §1 lists what is not content: `launch` is one more entry there.
- The bullet of ADR-0032 "Refusals of begin are seen only in the terminal until T94" becomes
  outdated for a work run of a runner that declares `signals`. So does the last bullet of L5 above.

The owner decides these separately.

## Amendment (T95, 2026-11-06): the trigger of a check, and `accepts=trigger`

Status of this amendment: **accepted**. The owner sets `accepted`. Its source is
§2.6 of the approved plan of M1 (2026-11-01), "Trigger and the compatibility of the runner" (Q6
"Refusal"). The rules are numbered V1–V6:

- V1–V5 are the rules V1–V5 of §2.6.
- V6 is not in §2.6. It is proposed by T95 to order V2 with K11 of T94 (see "Why V6").

They are apart from L1–L6 of T78 and K1–K17 of T94. What the trigger is, where it is stored and
what it means for a series of checks is in the amendment of T95 to ADR-0030. A rule of that
amendment is named here "ADR-0030 V<n>".

This amendment replaces nothing above. It adds to:

- T46 and ADR-0030 §6: `POST /tasks/:id/run` with `kind: 'check'` may carry a trigger;
- D13 of T54, the closed form of `accepts`: it gains the value `trigger` (V1);
- L5 of T78, "No field is added to any of them", as T94 already amended it: the value `trigger` of
  `accepts` (V1), the field `trigger` of `run.requested` (V3) and the field `trigger` of the begin
  of a check (V4) are added;
- K11 of T94: the order in which the runner drops what a board refuses (V6).

**The trigger in the request.**

- **`POST /tasks/:id/run` gains `trigger?`**, of the form of ADR-0030 V1:
  `{reason: 'task-done', task, doneAt, commit?}`. `task` and `doneAt` are required; `commit` is
  optional.
  - It is allowed **only with `kind: 'check'`**. With `work`, with `research`, or without `kind`,
    the answer is `400 INVALID_REQUEST`, **before a runner is asked**.
  - A trigger that is not of that form is `400 INVALID_REQUEST` too, before a runner is asked. This
    covers a missing `task` or `doneAt`, another `reason`, a `commit` that is not of the form of
    `aiRun.commit`, and any other field.
- **The trigger travels** from `/run` to `run.requested` (V3), from there into the body of the
  begin of the check, `POST /tasks/:id/checks` (V4), into the record `begin`, and into the check
  summary (ADR-0030 V2).
  - Begin accepts `trigger?` only for an actuality check, that is, without `kind`. With
    `kind: 'research'` the answer is `400 INVALID_REQUEST`, and nothing is written.
  - `commit` is the self-report of the `aiRun` of the source task. The agent verifies it through
    git.
  - No transcript, no copy of a text and no token travels with the trigger (O-3). It never
    reaches the arguments or the environment of `claude`.
- **K1 of T94 stands for a check with a trigger.**
  - Its request has no `requestId`, and the board writes no `launch` for it.
  - The runner sends no `run-failure` for it, and `/run` hands it with `hand()`.
  - A start that fails before begin is seen only in the runner's terminal. No `begin` is written,
    so the task stays not checked in its series (ADR-0030 V6).

**The rules.**

- **V1. The runner declares the trigger:** `GET /api/v1/runs?accepts=check,research,trigger`.
  - The closed form of `accepts` becomes a list of values from `check`, `research` and `trigger`.
  - `trigger` is not a kind of run. It says that the runner carries the trigger of a check from
    `run.requested` into begin (V4).
  - A runner without `trigger` in `accepts` is one of an earlier version for the trigger.
- **V2. Fallback.** When `GET /runs` with `trigger` in `accepts` is answered
  `400 INVALID_REQUEST`, the runner asks once more at once, with `accepts=check,research`.
  - This is one retry, not a loop.
  - The runner keeps no memory of this refusal: **every new connection** to `GET /runs` asks with
    `trigger` again.
- **V3. The trigger is handed only to a runner that declared it.** `run.requested` carries
  `trigger` only when the request has one and the runner that receives it declared `trigger` in
  `accepts`. For any other runner, the event is exactly the one it knows.
- **V4. The runner copies the trigger into begin byte for byte.**
  - The runner sends, in the body of `POST /tasks/:id/checks`, the `trigger` it received in
    `run.requested`, unchanged. It adds, drops and rewrites nothing in it.
  - The handoff of the check is built by the server from the record `begin` (ADR-0030 V2), not
    from the request and not by the runner.
- **V5. A check with a trigger and only earlier runners** → `409 NO_AGENT_RUNNER` (`outdated`).
  - The board hands a check with a trigger only to a waiting runner whose `accepts` holds both
    `check` and `trigger`.
  - If runners wait but none of them holds both, the answer is `409 NO_AGENT_RUNNER` with the
    existing text for a runner of an earlier version (`outdated`). If no runner waits at all, the
    answer is `409 NO_AGENT_RUNNER` as today.
  - Either way **nothing is handed to any runner and nothing is written**.
  - The board never drops the trigger to hand the check to an earlier runner.
  - A check without a trigger is handed as before, to a runner that accepts `check`, and its
    `run.requested` has no `trigger`.
- **V6. The order of V2 and K11 in one attempt to connect.** An attempt is one wait on
  `GET /runs`, from its first request until a stream is open. Within one attempt the runner sends
  at most three requests, in this order:
  1. `accepts=check,research,trigger`, and `signals=run-failure` if K11 has not marked this
     board's token.
  2. Only if request 1 is answered `400 INVALID_REQUEST`: `accepts=check,research`, with the same
     `signals` as request 1 (V2).
  3. Only if request 2 had `signals` and is answered `400 INVALID_REQUEST` too: K11 applies. The
     runner marks the token, tells the person once, and asks once more with
     `accepts=check,research` and without `signals`.

  - **K11's conclusion "this board refuses `signals`" is drawn only from a `400` to request 2**,
    a request without `trigger`. A `400` to request 1 never marks the token.
  - **If the token is already marked**, request 1 has no `signals`, and `trigger` is still tried
    (V2). Request 2 then has no `signals` either, and there is no request 3.
  - **No request follows the last one.** A `400` to request 3, or to request 2 without
    `signals`, starts no further retry in this attempt.
  - **Every other answer**, to any of the requests, is handled as K11 says: "Every other answer of
    `GET /runs` keeps today's handling".

  So in one attempt `trigger` is dropped at most once and `signals` at most once, and there is no
  loop. The next attempt begins with `trigger` again (V2), and with `signals` only if the token is
  not marked (K11).

**Why V6.** A board of T94 knows `signals` but not `trigger`. It answers `400` to the first request
of V1. Before V6, K11 read every `400` to a request with `signals` as "a board of an earlier
version that refuses `signals`". So a runner would stop offering `signals` to a board that knows
them, and a failed start of a work run would not be shown on the page. A board that knows
`trigger` is later than T94 and knows `signals`, so a `400` to the request of step 1 says nothing
about `signals`.

**What does not change.**

- The server starts nothing.
- A request goes to exactly one runner.
- `work` and `research` are unchanged.
- A check without a trigger is unchanged.
- End, report and the journal of a check are unchanged; the journal holds no trigger.
- K1–K17 of T94 stand, except the order of V6.

**What this costs.** To start a check with a trigger, the runner has to be updated (V5). An earlier
runner keeps starting work, checks without a trigger and research.
