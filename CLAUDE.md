# local-project-board — instructions for agents

This file is read by Claude Code in a terminal and by every Board Runner task: when the board's
**Check command** setting is empty, a task is told to run "the checks of the project — its full
pipeline, as its README or CLAUDE.md describes it". This is that pipeline.

## Checks

```sh
npm run format:check
npm run lint
npm run typecheck
npm run check:cycles
npm test
```

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
- CI (GitHub Actions) always runs `npm run test:full`. `npm test` under `CI` is Full mode too.

## Board Runner

Board Runner tasks follow this file through the board's AI workflow: with **Check command**
empty, the pipeline above, so Smart mode. To make every task of the board run all tests, set
**Check command** to `npm run test:full` in the board settings; a single task can ask for it in
its text.
