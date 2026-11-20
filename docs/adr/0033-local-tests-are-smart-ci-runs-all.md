# ADR-0033: Local test runs are Smart; CI runs every test

Status: accepted (2026-11-20)

## Context

The Jest suite (`node` and `web` projects, ~145 files) takes minutes, and it is run many times
per task: by a person, by Claude Code in a terminal, by every Board Runner task before it
finishes. Most runs change a handful of files. Running everything every time is slow; running
"what seems related" by hand is unreliable and silent about what was left out.

Jest's own `--findRelatedTests`, `--onlyChanged` and `--changedSince` are not enough here:

- they follow only imports Jest sees. Jest's extractor **skips `import type`**, while ts-jest
  type-checks every test, so a change to a type can fail a test Jest would not select;
- they cannot follow a deleted file (it is no longer in the graph), a document a test reads
  (`README.md`, `docs/api.md`), or a test that walks `src/` instead of importing it
  (`test/api/run.test.ts`, `test/lint/boundaries.test.ts`, …);
- `--onlyChanged` ignores commits already on the branch; none of them explain their choice or
  say what did not run.

## Decision

- **`npm test` is Smart mode**, implemented once in `scripts/smart-test/` and used by every local
  caller: a terminal, Claude Code, Board Runner tasks (through `CLAUDE.md`, which their check
  step points to). There is no second selector.
- **What changed** is the working tree against the merge base with the base branch
  (`origin/HEAD`, `origin/main`, `origin/master`, `main`, `master`, or `--base`): commits on the
  branch, staged, unstaged and untracked files. A rename is followed on both sides.
- **Which tests** comes from Jest's own dependency graph (same configuration, `moduleNameMapper`
  and `@/` alias as a real run), built through Jest's API with an extractor that also keeps
  type-only imports, and asked once per changed file so the report can say why each test runs.
  On top of the graph (`scripts/smart-test/rules.mjs`, `plan.mjs`):
  - a deleted file, a non-code file, or a source file no test imports → the files that still
    name it (`git grep`), and their tests;
  - any change under `src/` → the tests that read the `src/` tree (detected from their text);
  - a setup file of a Jest project (and what it imports) → every test of that project.
- **Full mode** replaces Smart mode, with the reason printed, when: `package.json`, the lock
  file, Jest/TypeScript/ESLint configuration, an unknown root configuration file, a global
  `.d.ts` or the selector itself changed; git cannot answer (not a checkout, no commits, merge,
  rebase, cherry-pick or bisect in progress, unresolved conflicts, shallow clone, no base, no
  common history); the Jest graph cannot be built; 60% or more of the test files are selected;
  more than 300 files changed.
- **`npm run test:full`** is the plain Jest command (`--selectProjects node web`) and does not go
  through the selector, so it cannot depend on git or on the selector being right.
- **CI always runs `npm run test:full`.** `npm test` under `CI` (or `GITHUB_ACTIONS`) is Full mode
  as well and ignores any test selection, so a workflow that calls it cannot shrink the run.
  `test/smartTest/repository.test.ts` fails if a workflow runs `npm test` or a diff-based option.
- A Smart run says, before and after Jest's output, that it is **not a full check**, how many
  test files ran and how many did not (`--list-skipped` names them). A run with nothing to test
  starts no Jest and says so; it never prints a pass.

## Consequences

- A local `npm test` is usually seconds to a minute; correctness of everything else is CI's job,
  and CI stays the final gate.
- The selector errs towards running more: name matches by `git grep` are deliberately loose,
  and every rule can only add tests or widen to Full mode.
- What it cannot see: code reached only through a computed path that names no file, and tests
  that read the tree in a new way the text patterns do not recognise. Both are run by CI; a new
  tree-scanning test should follow the existing patterns or extend `TREE_SCANNER_PATTERNS`.
- `npm test -- <path>` keeps working as before (MANUAL selection, reported as such).
- `npm run test:pack` and `npm run test:e2e` are unchanged and outside both modes.
