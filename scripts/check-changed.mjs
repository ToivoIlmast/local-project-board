// @ts-check
/**
 * The local default checks (`npm run check`): Prettier and ESLint on the files this branch
 * changed, then `npm test -- --never-full` (Smart mode). Nothing whole-project and slow runs
 * here: full lint and format, full typecheck, `check:cycles`, the full Jest run, pack and E2E are
 * CI's job (.github/workflows/ci.yml) or are run by hand.
 *
 * When Smart mode would widen to every test (a changed `package.json`, lock file or
 * configuration, git that cannot answer, most of the suite reached…), Jest is NOT started: the
 * run says so, says why, and leaves the tests to CI or to an explicit `npm run test:full`.
 * Prettier and ESLint run either way.
 *
 * What changed is read the same way Smart mode reads it (scripts/smart-test/changes.mjs). When
 * git cannot answer, this does not guess and does not widen to a full lint: it says why and fails,
 * naming the full commands to run by hand.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectChanges } from './smart-test/changes.mjs';
import { SKIPPED_FULL_EXIT } from './smart-test/cli.mjs';

/** Extensions ESLint is configured for in this repository. */
const LINTED = /\.(?:[cm]?js|jsx|ts|tsx|mts|cts)$/;

/** Windows limits a command line to ~32k characters; keep each call well under it. */
const CHUNK = 80;

export const PRETTIER_ARGS = [
  'node_modules/prettier/bin/prettier.cjs',
  '--check',
  '--ignore-unknown',
];
export const ESLINT_ARGS = ['node_modules/eslint/bin/eslint.js', '--no-warn-ignored'];
export const TEST_ARGS = ['scripts/smart-test/main.mjs', '--never-full'];

/**
 * Which of the changed files each tool should look at. Deleted files are gone; Prettier skips
 * what it does not know and what `.prettierignore` lists on its own.
 * @param {import('./smart-test/changes.mjs').Change[]} changes
 * @returns {{ format: string[], lint: string[] }}
 */
export function filesToCheck(changes) {
  const present = changes.filter((c) => c.status !== 'D').map((c) => c.path);
  return { format: present, lint: present.filter((path) => LINTED.test(path)) };
}

/**
 * @typedef {object} CheckDeps
 * @property {typeof collectChanges} collectChanges
 * @property {(path: string) => boolean} exists
 * @property {(args: string[], root: string) => number | null} node  Runs `node <args>`.
 * @property {(line: string) => void} out
 */

/** @type {CheckDeps} */
const realDeps = {
  collectChanges,
  exists: existsSync,
  node: (args, root) => spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' }).status,
  out: (line) => process.stdout.write(`${line}\n`),
};

/**
 * @param {CheckDeps} deps
 * @param {string} root
 * @param {string} label
 * @param {string[]} command  node arguments before the file list
 * @param {string[]} files
 * @returns {boolean}
 */
function runOn(deps, root, label, command, files) {
  if (files.length === 0) {
    deps.out(`\n${label}: no changed files to check.`);
    return true;
  }
  deps.out(`\n${label}: ${files.length} changed file(s).`);
  let ok = true;
  for (let i = 0; i < files.length; i += CHUNK) {
    if (deps.node([...command, ...files.slice(i, i + CHUNK)], root) !== 0) ok = false;
  }
  return ok;
}

/**
 * @param {{ root?: string, deps?: Partial<CheckDeps> }} [input]
 * @returns {Promise<number>}
 */
export async function main({
  root = realpathSync.native(fileURLToPath(new URL('../', import.meta.url))),
  deps: overrides = {},
} = {}) {
  /** @type {CheckDeps} */
  const deps = { ...realDeps, ...overrides };
  const found = await deps.collectChanges({ root });
  if (!found.ok) {
    deps.out(
      `Cannot tell which files changed: ${found.reason}.\n` +
        'Run the whole-project checks by hand instead: npm run format:check && npm run lint',
    );
    return 1;
  }
  const { format, lint } = filesToCheck(found.changes);
  const existing = (/** @type {string[]} */ files) =>
    files.filter((f) => deps.exists(join(root, f)));

  const formatOk = runOn(deps, root, 'Prettier', PRETTIER_ARGS, existing(format));
  const lintOk = runOn(deps, root, 'ESLint', ESLINT_ARGS, existing(lint));

  deps.out('\nTests: npm test -- --never-full (Smart mode, never Full)');
  const testCode = deps.node(TEST_ARGS, root);
  const testsSkipped = testCode === SKIPPED_FULL_EXIT;
  const testsOk = testCode === 0 || testsSkipped;

  const word = (/** @type {boolean} */ ok) => (ok ? 'passed' : 'FAILED');
  deps.out('');
  deps.out(`Prettier (changed files): ${word(formatOk)}`);
  deps.out(`ESLint (changed files):   ${word(lintOk)}`);
  deps.out(
    testsSkipped
      ? 'Jest:                     SKIPPED — NOT RUN. Smart mode needed every test; check them in ' +
          'CI or with `npm run test:full`.'
      : `Jest (Smart mode):        ${word(testsOk)}`,
  );
  deps.out(
    'Local checks only: changed files and Smart tests. Full lint, format, typecheck, ' +
      'check:cycles, the full Jest run, pack and E2E run in CI.',
  );
  return formatOk && lintOk && testsOk ? 0 : 1;
}
