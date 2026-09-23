# local-project-board

> A personal developer board in seconds. No ceremony. No cloud required. Sharing when you need it.

**Status: pre-alpha.** The board runs and serves its API; the browser UI is still a placeholder,
so today this is a board for the command line and for AI agents.
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
ai: { allowSourceEdits: false }
```

Settings are read from the flags first, then `BOARD_PORT`, `BOARD_OPEN`, `BOARD_PROJECT_NAME`,
`BOARD_ID_PREFIX`, `BOARD_STORAGE_PROVIDER`, then `board.config.yaml`, then
`~/.config/local-project-board/config.yaml`, then the defaults. A key that is misspelled or a
value that is out of range stops the board with a message naming the key and where it came from.
Removing a status that tasks still use also stops the board, rather than hiding those tasks.

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

| Command                                   | What it does                                   |
| ----------------------------------------- | ---------------------------------------------- |
| `npm install`                             | Install dependencies                           |
| `npm run build`                           | Build the server and the UI                    |
| `npm test`                                | Jest tests                                     |
| `npm run test:pack`                       | Build the npm package, install it and start it |
| `npm run lint`                            | ESLint, including architecture rules           |
| `npm run typecheck`                       | TypeScript                                     |
| `npm run format` / `npm run format:check` | Prettier                                       |

## License

[MIT](LICENSE)
