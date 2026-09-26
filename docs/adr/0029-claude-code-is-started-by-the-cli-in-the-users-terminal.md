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
  task, not about which agent it is.
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
