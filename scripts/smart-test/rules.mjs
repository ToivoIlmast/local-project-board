// @ts-check
/**
 * The rules of Smart mode (docs/adr/0033). Everything that decides how far a change reaches
 * beyond what Jest's dependency graph can see lives here, in one table, so a reviewer can read
 * the whole policy at once and a new rule is a new row, not a new branch in the planner.
 *
 * The direction of every rule is the same: when in doubt, run more. A rule may widen the set of
 * tests (up to Full mode); no rule may narrow what the dependency graph selected.
 */

/** The Jest projects that `npm test` and `npm run test:full` run; `pack` is `npm run test:pack`. */
export const JEST_PROJECTS = /** @type {const} */ (['node', 'web']);

/** Node and the Jest it starts: the start of every command line of the runner. */
export const JEST_BIN_ARGS = ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js'];

/**
 * The projects to run. `--selectProjects` takes a list: Jest reads every argument after it that
 * is not an option as one more project, so a test path right after it is lost as a project name
 * and every test runs. Whatever follows it must start with an option, or it must come last.
 */
export const PROJECT_ARGS = ['--selectProjects', ...JEST_PROJECTS];

/**
 * The exact Full-mode command. `npm run test:full` is this command and nothing else, so CI does
 * not depend on the selector at all; test/smartTest/repository.test.ts keeps the two equal.
 */
export const FULL_JEST_ARGS = [...JEST_BIN_ARGS, ...PROJECT_ARGS];

/**
 * @typedef {object} PathRule
 * @property {RegExp} pattern  Matched against the repository-relative path with `/` separators.
 * @property {string} why      Said in the report when the rule applies.
 */

/**
 * A change to any of these can reach every test without an import Jest could follow:
 * dependencies, the toolchain, the configuration of Jest/TypeScript/ESLint, global type
 * declarations and the selector itself. Smart mode turns into Full mode.
 * @type {PathRule[]}
 */
export const FULL_RULES = [
  { pattern: /^package\.json$/, why: 'npm scripts or dependencies' },
  { pattern: /^(package-lock|npm-shrinkwrap)\.json$/, why: 'locked dependency versions' },
  { pattern: /^\.(npmrc|nvmrc|node-version)$/, why: 'npm / Node.js toolchain settings' },
  { pattern: /^jest\.config\.[cm]?[jt]s$/, why: 'Jest configuration' },
  { pattern: /^tsconfig[^/]*\.json$/, why: 'TypeScript configuration (ts-jest compiles with it)' },
  { pattern: /^(babel|eslint)\.config\.[cm]?[jt]s$/, why: 'tool configuration read by tests' },
  { pattern: /^scripts\/smart-test\//, why: 'the test selector itself changed' },
  { pattern: /^(src|test)\/.*\.d\.[cm]?ts$/, why: 'global type declarations' },
];

/**
 * Checked by other runners, not by the `node`/`web` Jest projects. The report names the command
 * that does check them; a file here is still searched for references from Jest's files.
 * @type {PathRule[]}
 */
export const OUTSIDE_RULES = [
  {
    pattern: /^(test\/e2e\/|playwright\.config\.)/,
    why: 'Playwright: `npm run test:e2e` (CI runs it)',
  },
  { pattern: /^test\/pack\//, why: 'package smoke test: `npm run test:pack` (CI runs it)' },
  {
    pattern: /^(bin\/|vite\.config\.)/,
    why: 'build and packaging: `npm run test:pack` and `npm run test:e2e` (CI runs them)',
  },
  { pattern: /^\.github\//, why: 'CI configuration: verified by the CI run itself' },
];

/** Source code: Jest's dependency graph knows these files. */
export const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** A file at the top of the repository that a tool may load as configuration. */
export const ROOT_CONFIG_FILE = /^[^/]+\.(ts|mts|cts|js|mjs|cjs|json)$/;

/** Where Jest's projects take their code and tests from. */
export const JEST_ROOTS = /^(src|test)\//;

/**
 * Tests that read the source tree itself (walk `src/`, lint it, read files by a computed path)
 * rather than import it. Jest cannot relate a change to them, so they run whenever anything
 * under `src/` changes. Detected from the text of each test, so a new test written the same way
 * is picked up without touching this file.
 */
export const TREE_SCANNER_PATTERNS = [
  /join\(\s*process\.cwd\(\)\s*,\s*['"]src['"]/,
  /new\s+ESLint\s*\(/,
  /new\s+URL\(\s*`[^`]*\bsrc\/[^`]*\$\{/,
];

/** When at least this share of all test files is selected, running the rest costs little. */
export const FULL_THRESHOLD = 0.6;

/** More changed files than this is a mass change (a merge, a rename sweep): run everything. */
export const MAX_CHANGED_FILES = 300;
