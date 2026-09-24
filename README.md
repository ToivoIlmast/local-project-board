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

| Command                                | What it does                                              |
| -------------------------------------- | --------------------------------------------------------- |
| `npx local-project-board`              | Start the board                                           |
| `npx local-project-board instructions` | Print the API instructions to hand to an AI agent         |
| `npx local-project-board export`       | Print a snapshot of the board (`--out <file>` to save it) |

Options: `--port <number>` (a port you name must be free, or the board stops with an error),
`--no-open` (do not open a browser), `--help`.

## In the browser

The board is one screen: the statuses of your project as columns, and a panel on the right for
whatever you are looking at.

- **Tasks.** Create, edit and delete them; drag a card between columns, or move it from the
  card's menu — the keyboard alone is enough for everything. The server decides the order, so
  two windows never disagree about it.
- **A task in detail.** Title, status, labels, branch, dates and a markdown description, with
  the documents that belong to the task next to it.
- **Documents.** Read them as markdown, write and change them in the page, delete them. An
  `.html` document opens in a frame of its own, sandboxed by the server.
- **Reports.** Whatever an agent has stored, HTML or markdown, opened the same safe way.
- **Git.** The current branch, whether the tree is clean, what changed, the diff of a file and
  the last ten commits.
- **Live.** A task created by an agent, a file edited in your editor, a report written by a
  script: the page follows without a reload, and says so when the board stops answering.
- **AI instructions.** The same text `npx local-project-board instructions` prints, one button
  away and ready to paste.

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
  allowSourceEdits: false
  rules:
    - Never delete a task without asking first.
    - Ask before renaming a status.
```

Settings are read from the flags first, then `BOARD_PORT`, `BOARD_OPEN`, `BOARD_PROJECT_NAME`,
`BOARD_ID_PREFIX`, `BOARD_STORAGE_PROVIDER`, then `board.config.yaml`, then
`~/.config/local-project-board/config.yaml`, then the defaults. A key that is misspelled or a
value that is out of range stops the board with a message naming the key and where it came from.
Removing a status that tasks still use also stops the board, rather than hiding those tasks.

`ai.rules` is the "## Rules" section of the AI instructions below — what an agent must not
violate about the mechanics of the API. The board ships with a small built-in default; setting
`ai.rules` in either config file replaces that whole list, it does not add to it. The rules a
board actually hands out right now are always the ones `npx local-project-board instructions`
prints — including the built-in defaults when nothing overrides them — so this file never needs
to repeat them.

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

prints everything an agent needs to use the board through its API: the base URL, the token (when
the board is running), the statuses of this board and every route with its examples. Hand that
text to Claude, ChatGPT or your own tool, and it can read the board, create and move tasks, write
documents and store reports.

## Principles

See [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md).

## Development

Requires Node.js >= 22.12.0.

| Command            | What it does                                 |
| ------------------ | -------------------------------------------- |
| `npm install`      | Install dependencies                         |
| `npm run build`    | Build the server and the UI                  |
| `npm test`         | Jest tests (server and page)                 |
| `npm run test:e2e` | Playwright, against a board started for real |

The browser tests need a browser once: `npx playwright install --with-deps chromium`.
| `npm run test:pack` | Build the npm package, install it and start it |
| `npm run lint` | ESLint, including architecture rules |
| `npm run typecheck` | TypeScript |
| `npm run format` / `npm run format:check` | Prettier |

## License

[MIT](LICENSE)
