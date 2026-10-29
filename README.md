# local-project-board

> A personal developer board in seconds. No ceremony. No cloud required. Sharing when you need it.

**Status: pre-alpha.** The board runs, serves its API and has a working browser UI; it has not
been used in anger yet.
Translations: [Suomi](README.fi.md) · [Svenska](README.sv.md)

## What it is

local-project-board is a local workspace for one developer and one Git repository: tasks, notes,
Markdown documents, reports, Git context and AI output, side by side. It is closer to an advanced
developer notebook than to a project management system.

## Quick start

```bash
cd my-project
npx local-project-board
```

The board starts on `http://127.0.0.1:7432/` (the next free port if that one is taken) and opens
in your browser. No sign-up, no account, no database, no network beyond your own machine.

| Command                                          | What it does                                              |
| ------------------------------------------------ | --------------------------------------------------------- |
| `npx local-project-board`                        | Start the board                                           |
| `npx local-project-board instructions`           | Print the API instructions to hand to an AI agent         |
| `npx local-project-board claude <ID>`            | Start Claude Code on a task, in this terminal             |
| `npx local-project-board claude <ID> --check`    | Start Claude Code on a check of whether a task is current |
| `npx local-project-board claude <ID> --research` | Start Claude Code on a research of how to approach a task |
| `npx local-project-board claude --wait`          | Start Claude Code here on each task sent from the board   |
| `npx local-project-board claude --recover <ID>`  | Check a run whose runner died; mark it lost on proof      |
| `npx local-project-board export`                 | Print a snapshot of the board (`--out <file>` to save it) |

Options: `--port <number>` (a port you name must be free, or the board stops with an error),
`--no-open` (do not open a browser), `--version` (print the version and exit), `--help`.

## In the browser

The board is one screen: the statuses of your project as columns, and a panel on the right for
whatever you are looking at.

- **Tasks.** Create, edit and delete them; drag a card between columns, or move it from the
  card's menu — the keyboard alone is enough for everything. The server decides the order, so
  two windows never disagree about it.
- **A task in detail.** Title, status, labels, branch, dates and a markdown description, with
  the documents that belong to the task next to it.
- **Versions.** Every real change to a task's title, labels or description makes a version, and
  none is ever overwritten or deleted (only the task's deletion removes them). A select at the
  top of the task shows the current version or a historical one, a list shows what each changed
  and where it came from (an edit, a restore, a change made outside the board), any two can be
  compared as a diff, and a historical one can be restored — as a new version; the status does
  not change. **Edit** shows the draft as a diff against the current content before it saves,
  sends only what you changed, and, if the task changed in the meantime, keeps your draft and
  shows it against the new content instead of overwriting anything. Tasks that existed before
  get their first version the first time they are changed.
- **Check actuality.** A button in every task, in any status, asks Claude Code (through the same
  runner as Send to AI) to compare the task with the repository. It writes a report that is
  stored as it was sent, apart from the versions and tied to the version it read: a verdict, the
  findings with their evidence, what it could not tell, and recommendations. You accept or
  reject each recommendation; **Apply accepted** opens the editor with them applied, and nothing
  changes until you save. A report for a version the task has left is marked stale and is not
  applied for you. The check changes no file and no git state; the board does not enforce that,
  it shows the repository before and after. See [Claude Code](#claude-code).
- **AI research.** Next to the checks, **New research…** asks Claude Code (through the same
  runner) how to approach the task: what it asks for, what the repository already has, how the
  work could be done and what could go wrong. You may give it a focus and a model. The research
  reads the version of the task that was current when it began, and writes a Markdown report with
  findings and recommendations that is stored once and never rewritten; it gives no verdict and
  does not say whether the task is ready — that stays with you. You accept or reject each
  recommendation, a rejection with a reason if you like. One that edits the title, labels or
  description is applied through the editor, as with a check; one aimed at a document or a file
  of the project is carried over by hand. The next research of the task is shown the earlier ones
  with your decisions and reasons, and is told not to propose again what you rejected without new
  evidence. A research never starts the work and never touches the task's **AI run**: the work is
  a separate **Send to AI → Claude Code**, whose dialog mentions a research still working or with
  undecided recommendations, and starts anyway. Research is told not to change anything; the board
  shows whether anything changed: the branch, the commit and whether the tree was clean at the
  start, at the report and at the end, the files that changed meanwhile, the documents of the task
  changed since, and a repository that moved on after the report. Who changed it, the board does
  not say. See [Claude Code](#claude-code).
- **Documents.** Read them as markdown, write and change them in the page, delete them. An
  `.html` document opens in a frame of its own, sandboxed by the server.
- **Reports.** Whatever an agent has stored, HTML or markdown, opened the same safe way.
- **Git.** The current branch, whether the tree is clean, what changed, the diff of a file and
  the last ten commits.
- **Live.** A task created by an agent, a file edited in your editor, a report written by a
  script: the page follows without a reload, and says so when the board stops answering.
- **AI instructions.** The same text `npx local-project-board instructions` prints, one button
  away and ready to paste.
- **Settings.** How an agent works on a task — change files, work in a branch, run the checks,
  commit, push, write a report — for the whole board and for each column. Only what you change is
  stored, in `.board/workflow.yaml`; a column can simply follow the board. A single task can
  differ too: open it to see where each value in effect comes from, override one setting, or send
  the task back to its column's settings. The language of the agent's report is one of 14
  (English by default) and can be set for the board and for a single task; it is not the language
  of the board's page. The language of commit messages is a separate setting of the board alone —
  the same 14, or none, which leaves it to the convention of the project; the task id, file names
  and trailers are never translated, and branch names stay English. Leaving a form with unsaved
  changes asks first: Save, Discard or Cancel.
- **Send to AI.** In a task, or in the menu of its card, one entry copies the handoff — the task,
  its documents and the steps its settings call for — ready to paste into any agent. It holds no
  token. `npx local-project-board handoff <ID>` prints the same text. The second entry,
  **Claude Code**, starts Claude Code on that task in the terminal where
  `npx local-project-board claude --wait` runs; see [Claude Code](#claude-code).
- **AI run.** What the last agent on a task reported about its run — which agent, how it went,
  the checks, its commit, when it started and finished — is shown in the task, marked as the
  agent's own word: the board does not check it.

Files the board cannot read are shown as exactly that, above the columns — never as tasks with
invented values.

## Where the board lives

The board belongs to the repository, not to the branch: it is stored in `.board/` next to your
`.git`, so every worktree of the repository opens the same board and `git checkout` never touches
it. Outside a repository, `.board/` is created in the current directory. `.board/` is untracked —
`npx local-project-board export` is how you back it up.

`board.config.yaml` at the repository root is optional and is meant to be committed: it is the
shape of the board.

```yaml
project: { name: my-project }
statuses: [backlog, todo, in-progress, done]
tasks: { idPrefix: T }
storage: { provider: markdown }
server: { port: 7432, open: true }
ai:
  rules:
    - Never delete a task without asking first.
    - Ask before renaming a status.
```

Settings are read from the flags first, then `BOARD_PORT`, `BOARD_OPEN`, `BOARD_PROJECT_NAME`,
`BOARD_ID_PREFIX`, `BOARD_STORAGE_PROVIDER`, then `board.config.yaml`, then
`~/.config/local-project-board/config.yaml`, then the defaults. A key that is misspelled or a
value that is out of range stops the board with a message naming the key and where it came from.
Removing a status that tasks still use also stops the board, rather than hiding those tasks.

`ai.rules` are your project's own conventions for an agent — what no setting expresses, such as
the language of comments or the style of commit messages. The AI instructions below list them
under "Project rules", after the rules of the API. Those are always there: `ai.rules` adds to them
and cannot remove or replace one, and an empty list adds nothing. A layer's list replaces the
list of the layer below it, as every list in this file does. What an agent may do on a task —
change files, work in a branch, run the checks, commit, push, write a report — is not for
`ai.rules`: those are the AI workflow settings, stored in `.board/workflow.yaml` and answered by
`GET /api/v1/workflow`; `npx local-project-board handoff <id>` prints the steps that apply to one
task. Whether an agent may change files is the setting `editCode`; the old `ai.allowSourceEdits`
never had an effect and is gone, so a config that still has it stops the board with a message
saying so. What a board hands out right now is always what `npx local-project-board instructions`
prints, so this file never needs to repeat the rules.

## While it runs

A running board writes `.board/runtime.json` — its pid, port, URL, board root and the session
token of this run — readable by you only, and removes it on `Ctrl+C`. It is how the CLI finds a
running board, and how a second board on the same directory is refused.

The server listens on the loopback interface and nowhere else; there is no flag to change that.
Reading the API needs nothing, changing anything needs this run's token, and requests from another
page or addressed to another host are refused.

## With an AI agent

```bash
npx local-project-board instructions
```

prints everything an agent needs to use the board through its API: the base URL, the placeholder
`<session token>` and the route `GET /api/v1/session` that gives the real one, the statuses of this
board and every route with its examples. The text never contains the token itself, whether the
board is running or not, so it is safe to paste into a chat. Hand that text to Claude, ChatGPT or
your own tool, and it can read the board, create and move tasks, write documents and store
reports. The project also supports AI-assisted task execution through
[Claude Code](#claude-code).

The full route reference — every route, including the ones this text leaves out, every error code
and media type — is [docs/api.md](docs/api.md), generated from the same route table.

## AI workflow

How an agent works on a task is set at three levels; a later level wins, setting by setting:

1. **Board** — every setting.
2. **Column** (status) — the six on/off settings only.
3. **Task** — the six on/off settings and the report language.

The on/off settings and their defaults: change files (`editCode`) on, work in a branch on, run the
checks on, commit on, push off, write a report on. The board alone also sets the status a task is
moved to when work starts (`in-progress` if the board has it) and when it ends (`done` if the
board has it; otherwise none), the base branch and the check command (both unset by default), and
the language of commit messages (unset). The report language is English unless set.

Only what you change is stored: the board's and the columns' in `.board/workflow.yaml`, a task's in
the `workflow:` field of its `task.md`. The defaults are never written. While change files is off,
branch, checks, commit and push do not apply; they keep their values and the handoff says so.
`GET /api/v1/workflow` answers the board's and columns' settings with the defaults, and
`GET /api/v1/tasks/<ID>/workflow` the settings of one task with the source of each.

To send a task to an agent, use **Send to AI** in the task or in the menu of its card: **Copy
handoff** copies the task, its documents and the steps its settings call for (the same text as
`npx local-project-board handoff <ID>`), and **Claude Code** starts a session on it; see
[Claude Code](#claude-code). Limits: the steps are instructions to the agent, not something the
board enforces, and an agent never merges and never keeps the token: it does not print it, write it to a file or
type it into a command, and it sends the header through stdin so that it stays out of the argv of
any process. The reasons are in
[ADR-0028](docs/adr/0028-ai-workflow-settings-three-levels-overrides-only.md).

## Claude Code

Start a runner once, in a terminal in the project, next to the running board:

```bash
npx local-project-board claude --wait
```

From then on **Send to AI → Claude Code** in a task (or in the menu of its card) starts Claude Code
on that task in that terminal. When the session ends, the runner waits for the next task. Without
a runner, typing

```bash
npx local-project-board claude T13
```

starts the same session on task `T13` directly. Either way `claude` is started in the root of the
project, as a new session, with one short prompt that points at the live handoff of the task
(`GET /api/v1/tasks/T13/handoff`). Claude reads it itself, so it always sees the task, the settings
as they are now and the API instructions, and follows its steps: a branch, the work, the checks, a
commit, a `report.md`, and its run recorded in the task (`aiRun`), which the page shows as
**AI run**.

What to know:

- The board must be running (`npx local-project-board`, in another terminal), and `claude` must be
  in your PATH. Otherwise the command says which of the two is missing, and starts nothing.
- The board never starts `claude` itself: a server that runs programs would turn its token into
  the right to run code on your machine, and it has no terminal to give an interactive program
  ([ADR-0029](docs/adr/0029-claude-code-is-started-by-the-cli-in-the-users-terminal.md)). The
  page only asks the board to hand the task to the runner you started; the runner decides what
  runs.
- One session at a time: while a session runs, **Send to AI → Claude Code** says that nothing is
  waiting, and starts nothing. So does it when no runner is started; it then tells you the two
  commands above.
- The model is a parameter of the run, not of the workflow. By default it is your own Claude Code
  setting and the board passes none; if a run names one, the runner starts `claude --model <it>` and
  the run records it as `aiRun.model`. It is either an alias (`opus`, `sonnet`, `fable`, `haiku`) or
  a full name of the form `claude-…`; anything else is refused. A name that `claude` itself does not
  know ends the run as failed. The permission mode and the rest are still your own settings. There
  is no token in the prompt or in the arguments.
- **Send to AI → Claude Code** first opens a small dialog with three controls: the model (the
  Claude Code default, an alias or another full name; the model of the last run when it had one),
  the report language and the session. The language is a setting of the task: a change is saved
  to the task before the start, and when it cannot be saved nothing starts. The session is a new
  one, or — when the last run left a session — Resume, which continues it. Left as it opens, the
  dialog starts exactly what the click started before it.
- The **AI run** block of a task tells the lifecycle of the session: the attempt (`#runId`), the
  state, the model and the mode, which the runner wrote, and the agent, checks and commit, which
  the agent reported and the block marks so. A run that failed says why in words (not started,
  ended without a final report with its code, the agent's own message, or lost). For a run that
  `failed` or `needs-review` it has two buttons: **Resume**, which opens the dialog above on the
  session of that run, and **Restart**, which asks first — the old branch is renamed to
  `…-attempt-N`, nothing is deleted — and then starts the work over in a new session. Neither is
  there while Claude Code works, and a run from before sessions has no Resume. The block also
  copies `claude --resume <session>` for continuing by hand. The card shows `AI: failed #N`.
- Claude has to make HTTP requests to `127.0.0.1` — it uses `curl` through its Bash tool — and
  Claude Code asks for permission for that by default. Allow `Bash(curl *)` for the session, or in
  your Claude Code settings if you want no questions.
- The session works in your checkout of the project, so the branch it creates is the branch that
  is checked out afterwards. A worktree for each task is not done yet.
- If the runner dies mid-session (its terminal is closed, the machine sleeps, it is killed), the
  task stays **working** and nothing can start on it. Run
  `npx local-project-board claude --recover <ID>` in a terminal of the project. It first delivers
  any end the runner wrote down and could not send (the runner keeps it in `.board/runner/`, so it
  survives the runner and a restart of the board), then looks at this machine: **alive** — the
  board is left alone; **lost** — the runner and `claude` it recorded are gone, and the run is
  marked `failed` (`failure.kind: lost`) with the evidence; **unknown** — this machine cannot show
  it (no `/proc`, another OS or PID namespace, a run started elsewhere), and nothing changes unless
  you add `--confirm-stopped`, which the run then records. The run keeps its `runId` and session,
  so Resume continues it as the next run. The age of a run is never taken as a sign it is lost.
- **Check actuality** in a task starts the same runner on a check, and
  `npx local-project-board claude <ID> --check` starts one directly. A check is a session of its
  own kind: it does not touch the task's AI run, so it is not refused while a run works, and it
  needs no recovery — if its runner dies the check simply stays without a report and blocks
  nothing. It is told, in its handoff, to change no file, to run no git command that writes and to
  write nothing to the board but its report; that is an instruction and the permissions of your
  Claude Code, not something the board can enforce, so the report shows the branch, the commit and
  whether the tree was clean when the check began and when it reported. Its end is kept in
  `.board/runner/<ID>-check-<n>.json` until the board takes it, apart from the journals of runs.
- **New research…** in a task starts the same runner on a research, and
  `npx local-project-board claude <ID> --research --comment "<focus>"` starts one directly
  (`--comment` is optional, at most 4000 characters). A research is a check of its own kind: it
  is numbered with the checks of the task (`T13-C2`), kept in the same kind of journal, not
  refused while a run works, and changes nothing on the task until you apply a recommendation.
  The focus goes to the board with the start of the research and reaches Claude through its
  handoff, never through the command line. Its report, your decisions and the end of its session
  survive a restart of the board. A research whose session died stays **working**, blocks
  nothing and is not recovered: start a new one. A runner of an earlier version is never handed a
  research; the page then says to update it.

## Principles

See [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md). How the code is laid out, and where new code
goes, is in [docs/architecture.md](docs/architecture.md).

## Development

Requires Node.js >= 22.12.0.

| Command                                   | What it does                                        |
| ----------------------------------------- | --------------------------------------------------- |
| `npm install`                             | Install dependencies                                |
| `npm run build`                           | Build the server and the UI                         |
| `npm start`                               | Start the board from the build                      |
| `npm run start:claude -- --wait`          | `claude --wait` from the build (`-- T13`: one task) |
| `npm test`                                | Jest tests (server and page)                        |
| `npm run test:e2e`                        | Playwright, against a board started for real        |
| `npm run test:pack`                       | Build the npm package, install it and start it      |
| `npm run lint`                            | ESLint, including architecture rules                |
| `npm run typecheck`                       | TypeScript                                          |
| `npm run format` / `npm run format:check` | Prettier                                            |

The browser tests need a browser once: `npx playwright install --with-deps chromium`.

Translations (`README.fi.md`, `README.sv.md`) follow `README.md`: after a commit that changes it, update them and set their first line to `<!-- Based on README.md @ <that commit> -->` — `npm test` fails while they differ.

## License

[MIT](LICENSE)
