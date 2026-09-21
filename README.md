# local-project-board

> A personal developer board in seconds. No ceremony. No cloud required. Sharing when you need it.

**Status: pre-alpha.** Nothing is usable yet. This README describes the goal, not a finished feature.
Translations: [Suomi](README.fi.md) · [Svenska](README.sv.md)

## What it is

local-project-board is a local workspace for one developer and one Git repository: tasks, notes,
Markdown documents, reports, Git context and AI output, side by side. It is closer to an advanced
developer notebook than to a project management system.

## Quick start (planned)

```bash
cd my-project
npx local-project-board
```

The board opens in your browser. No sign-up, no account, no database.

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
