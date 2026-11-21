# local-project-board — instructions for agents

This file is read by Claude Code in a terminal and by every Board Runner task: when the board's
**Check command** setting is empty, a task is told to run "the checks of the project — its full
pipeline, as its README or CLAUDE.md describes it". This is that pipeline.

## Checks

Locally, by default, run only the fast checks of what you changed:

```sh
npm run check
```

It runs, against the files this branch changed since its base branch (the same change set as
Smart mode):

- **Prettier** `--check` on the changed files;
- **ESLint** on the changed code files;
- **`npm test -- --never-full`** — Smart mode, only the Jest tests the changes can reach. ts-jest
  type-checks every test file it runs and what it imports, so type errors in the touched area
  surface here; there is no separate fast typecheck of a part of the project.

`npm run check` **never starts a Full Jest run on its own.** When Smart mode would widen to
every test (`package.json`, a lock file, Jest/TypeScript/ESLint configuration, the selector
itself, git that cannot answer, most of the suite reached…), Jest is skipped: the run prints
`Tests: SKIPPED — JEST WAS NOT RUN` with the reason, Prettier and ESLint still run, and the
summary ends with `Jest: SKIPPED — NOT RUN`. The exit code then reflects Prettier and ESLint
only. Report it as such — "Jest was not run locally; CI runs every test" — never as tests
passing. Run `npm run test:full` (or `npm test -- --full`) only when the task or the person asks.

If git cannot tell what changed, `npm run check` fails and says why, rather than linting
everything.

**Do not run automatically** (CI runs them on every push and pull request): `npm run lint`,
`npm run format:check`, `npm run typecheck`, `npm run check:cycles`, `npm run test:full`,
`npm run build`, `npm run test:pack`, `npm run test:e2e`, or any other whole-project,
integration or architecture check. Run one locally only when the task or the person asks for
it, or when the change is exactly what that check guards (e.g. `check:cycles` after moving
imports between `src/` modules, `typecheck` after changing a `tsconfig*.json`).

`npm test` runs in **Smart mode** (docs/adr/0033-local-tests-are-smart-ci-runs-all.md): it reads
what this branch changed since its base branch — commits, staged, unstaged and untracked files —
and runs only the Jest tests those changes can reach. It prints which tests it chose and why,
and how many it did not run. It widens on its own, up to every test, whenever it cannot see how
far a change reaches (dependencies, configuration, the git state, most of the suite affected).

- **Full mode** is `npm run test:full`: every test of the `node` and `web` Jest projects, with no
  change detection. Run it when the task or the person asks for a full run.
- **Never report a Smart run as "all tests pass".** Quote its last line, e.g. "Smart mode
  passed: 12 of 145 test files ran, 133 did not". Only Full mode (or CI) checks everything.
- While iterating, `npm test -- <path or pattern>` runs exactly the tests you name (MANUAL).
  Finish with plain `npm test` so the selection covers everything you changed.
- `npm test -- --plan` shows what would run and why, without running it.
- Use `npm test` / `npm run test:full`, not `npx jest`, so every run reports what it covered.
- `npm run test:pack` and `npm run test:e2e` are separate and build first; CI runs them.
- CI (GitHub Actions) always runs every check, unchanged: full `format:check`, `lint`,
  `typecheck`, `check:cycles`, `npm run test:full`, `test:pack`, and E2E on Ubuntu and macOS.
  `npm test` under `CI` is Full mode too. Passing local checks is not a full check; CI is the
  final gate.

## Board Runner

Board Runner tasks follow this file through the board's AI workflow: with **Check command**
empty, the local checks above (`npm run check`), so changed files and Smart mode. To make every task of the board run all tests, set
**Check command** to `npm run test:full` in the board settings; a single task can ask for it in
its text.
