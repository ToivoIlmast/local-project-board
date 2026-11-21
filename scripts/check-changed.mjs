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
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChild } from './run-child.mjs';
import { collectChanges } from './smart-test/changes.mjs';
import { SKIPPED_FULL_EXIT } from './smart-test/cli.mjs';

/** Extensions ESLint is configured for in this repository. */
const LINTED = /\.(?:[cm]?js|jsx|ts|tsx|mts|cts)$/;

/**
 * Windows limits a command line to 32 767 characters; each call stays well under it. Calls are
 * cut by length, not by a count of files: every ESLint call builds the TypeScript program of the
 * project again (typed rules, `projectService`), so fewer calls is less time and memory.
 */
export const COMMAND_LINE_BUDGET = 24_000;

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
 * @property {(args: string[], root: string) => number | null | Promise<number | null>} node
 *   Runs `node <args>` and waits for it; a stop of this process is passed on to it.
 * @property {(line: string) => void} out
 */

/** @type {CheckDeps} */
const realDeps = {
  collectChanges,
  exists: existsSync,
  node: (args, root) => runChild(process.execPath, args, { cwd: root }),
  out: (line) => process.stdout.write(`${line}\n`),
};

/**
 * The files split into calls whose command lines stay under the budget, in order.
 * @param {string[]} command  node arguments before the file list
 * @param {string[]} files
 * @param {number} [budget]
 * @returns {string[][]}
 */
export function chunkFiles(command, files, budget = COMMAND_LINE_BUDGET) {
  // Each argument costs its length plus a space and the quotes Windows may add.
  const fixed = [process.execPath, ...command].reduce((sum, arg) => sum + arg.length + 3, 0);
  /** @type {string[][]} */
  const chunks = [];
  /** @type {string[]} */
  let current = [];
  let length = fixed;
  for (const file of files) {
    const cost = file.length + 3;
    if (current.length > 0 && length + cost > budget) {
      chunks.push(current);
      current = [];
      length = fixed;
    }
    current.push(file);
    length += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * @param {CheckDeps} deps
 * @param {string} root
 * @param {string} label
 * @param {string[]} command  node arguments before the file list
 * @param {string[]} files
 * @returns {Promise<boolean>}
 */
async function runOn(deps, root, label, command, files) {
  if (files.length === 0) {
    deps.out(`\n${label}: no changed files to check.`);
    return true;
  }
  deps.out(`\n${label}: ${files.length} changed file(s).`);
  let ok = true;
  // One call at a time: the tools never run side by side.
  for (const chunk of chunkFiles(command, files)) {
    if ((await deps.node([...command, ...chunk], root)) !== 0) ok = false;
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

  const formatOk = await runOn(deps, root, 'Prettier', PRETTIER_ARGS, existing(format));
  const lintOk = await runOn(deps, root, 'ESLint', ESLINT_ARGS, existing(lint));

  deps.out('\nTests: npm test -- --never-full (Smart mode, never Full)');
  const testCode = await deps.node(TEST_ARGS, root);
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
