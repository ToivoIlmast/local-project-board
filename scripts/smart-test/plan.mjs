// @ts-check
/**
 * Decides which tests a set of changes needs. Pure: git and Jest come in as functions, so every
 * rule is tested on its own (test/smartTest/plan.test.ts).
 *
 * For every changed file, in this order:
 *  1. a FULL rule (dependencies, configuration, the selector, global types) → Full mode;
 *  2. a file every test of a project loads (setup files) → that whole project;
 *  3. a test file → itself (a deleted one has nothing left to run);
 *  4. code under src/ or test/ → the tests Jest's dependency graph relates to it; for a deleted
 *     file, or one the graph relates to nothing, the files that still mention it by name, and
 *     their tests; anything under src/ also runs the tests that scan the src/ tree;
 *  5. any other file → the files under src/ and test/ that mention it by name, and their tests.
 * Then: too many selected tests, or too many changes → Full mode.
 */
import {
  CODE_FILE,
  FULL_RULES,
  FULL_THRESHOLD,
  JEST_ROOTS,
  MAX_CHANGED_FILES,
  OUTSIDE_RULES,
  ROOT_CONFIG_FILE,
} from './rules.mjs';

/**
 * @typedef {import('./changes.mjs').Change} Change
 * @typedef {import('./jest.mjs').TestFile} TestFile
 * @typedef {object} PlanInput
 * @property {Change[]} changes
 * @property {TestFile[]} tests
 * @property {(paths: string[]) => Promise<string[]>} related
 *   Tests that depend on any of `paths`, transitively (one question to Jest for many files).
 * @property {Map<string, string>} projectWide
 * @property {string[]} scanners
 * @property {(token: string) => Promise<string[]>} references
 *   Files under src/ and test/ whose text contains `token`.
 * @typedef {object} FileVerdict
 * @property {Change} change
 * @property {'full' | 'project' | 'tests' | 'none'} effect
 * @property {string} detail        One line for the report.
 * @property {string[]} tests       Tests this file selected.
 * @property {string | undefined} outside  Which other runner checks it, if any.
 * @property {boolean} uncovered    Code that no Jest test reaches.
 * @typedef {object} Plan
 * @property {'smart' | 'full' | 'none'} mode
 *   `none`: nothing that Jest checks changed, so no test runs.
 * @property {string[]} fullBecause   Why Smart mode became Full mode; empty in Smart mode.
 * @property {FileVerdict[]} files
 * @property {Map<string, string[]>} selected  Test → why (in Full mode: every test).
 * @property {string[]} skipped        Tests that will not run.
 * @property {number} total
 */

/** @param {string} path */
const fullRuleFor = (path) => FULL_RULES.find((rule) => rule.pattern.test(path));
/** @param {string} path */
const outsideRuleFor = (path) => OUTSIDE_RULES.find((rule) => rule.pattern.test(path));

/**
 * The text another file would contain to use `path`. An import names a module after a slash and
 * without its extension (`./rank.js` for `rank.ts`), and an `index` by its directory
 * (`./model`); any other file is named by its file name (`'README.md'`, `'api.md'`).
 * @param {string} path
 */
export function referenceToken(path) {
  const parts = path.split('/');
  const name = parts.at(-1) ?? path;
  if (!CODE_FILE.test(name)) return name;
  const stem = name.replace(/\.d\.[cm]?ts$|\.[^.]+$/, '');
  if (stem === 'index' && parts.length >= 2) return `/${parts.at(-2) ?? stem}`;
  return `/${stem}`;
}

/**
 * @param {PlanInput} input
 * @returns {Promise<Plan>}
 */
export async function planTests(input) {
  const testPaths = new Set(input.tests.map((t) => t.path));
  /** @type {Map<string, string[]>} */
  const selected = new Map();
  /** @type {string[]} */
  const fullBecause = [];
  /** @type {FileVerdict[]} */
  const files = [];

  /** @param {string} test @param {string} why */
  const select = (test, why) => {
    const reasons = selected.get(test) ?? [];
    if (!reasons.includes(why)) reasons.push(why);
    selected.set(test, reasons);
  };

  if (input.changes.length > MAX_CHANGED_FILES) {
    fullBecause.push(
      `${input.changes.length} files changed (more than ${MAX_CHANGED_FILES}): a mass change`,
    );
  }

  /**
   * Tests reached through the files that mention `path`: a test that names it, and the tests of
   * any other file that names it. Selects them, with the reason.
   * @param {string} path
   * @returns {Promise<{ tests: string[], via: string[] }>}
   */
  const throughReferences = async (path) => {
    const token = referenceToken(path);
    const mentions = (await input.references(token)).filter(
      (file) => file !== path && JEST_ROOTS.test(file),
    );
    const naming = mentions.filter((file) => testPaths.has(file));
    for (const test of naming) select(test, `names ${path}`);
    const code = mentions.filter((file) => !testPaths.has(file) && CODE_FILE.test(file));
    const shown =
      code.length > 2 ? `${code.slice(0, 2).join(', ')} +${code.length - 2}` : code.join(', ');
    const through = code.length > 0 ? await input.related(code) : [];
    for (const test of through) select(test, `depends on ${shown}, which names ${path}`);
    return { tests: [...new Set([...naming, ...through])].sort(), via: mentions };
  };

  for (const change of input.changes) {
    const { path, status } = change;
    const outside = outsideRuleFor(path)?.why;
    /** @type {FileVerdict} */
    const verdict = { change, effect: 'none', detail: '', tests: [], outside, uncovered: false };
    files.push(verdict);

    const full = fullRuleFor(path);
    if (full !== undefined) {
      verdict.effect = 'full';
      verdict.detail = full.why;
      fullBecause.push(`${path}: ${full.why}`);
      continue;
    }

    const project = input.projectWide.get(path);
    if (project !== undefined) {
      verdict.effect = 'project';
      verdict.detail = `loaded by every test of the \`${project}\` project`;
      for (const test of input.tests) {
        if (test.project === project) {
          select(test.path, `${path} is set up for every \`${project}\` test`);
          verdict.tests.push(test.path);
        }
      }
      continue;
    }

    const deletedTest =
      status === 'D' && /\.test\.[cm]?[jt]sx?$/.test(path) && outside === undefined;
    if (testPaths.has(path) || (deletedTest && JEST_ROOTS.test(path))) {
      if (status === 'D') {
        verdict.detail = 'test file deleted: nothing left to run';
      } else {
        verdict.effect = 'tests';
        verdict.detail = status === 'A' ? 'new test file' : 'changed test file';
        verdict.tests.push(path);
        select(path, verdict.detail);
      }
      continue;
    }

    // Tools load these by name from the top of the repository; no graph knows what they reach.
    if (!path.includes('/') && ROOT_CONFIG_FILE.test(path) && outside === undefined) {
      verdict.effect = 'full';
      verdict.detail = 'a configuration file at the top of the repository that no rule knows';
      fullBecause.push(`${path}: ${verdict.detail}`);
      continue;
    }

    /** @type {string[]} */
    const details = [];
    if (CODE_FILE.test(path) && JEST_ROOTS.test(path)) {
      const imported = status === 'D' ? [] : await input.related([path]);
      for (const test of imported) select(test, `depends on ${path}`);
      if (imported.length > 0) details.push(`${imported.length} test(s) depend on it`);
      /** @type {string[]} */
      let named = [];
      if (status === 'D' || imported.length === 0) {
        const { tests, via } = await throughReferences(path);
        named = tests;
        if (status === 'D') {
          details.push(
            via.length > 0
              ? `deleted; still named in ${via.length} file(s): ${tests.length} test(s)`
              : 'deleted; nothing names it any more',
          );
        } else if (via.length > 0) {
          details.push(`imported by no test; named in ${via.length} file(s)`);
        }
      }
      verdict.tests.push(...imported, ...named);
      verdict.uncovered = status !== 'D' && imported.length === 0 && named.length === 0;
      if (path.startsWith('src/')) {
        for (const test of input.scanners) select(test, 'scans the src/ tree');
        verdict.tests.push(...input.scanners);
        if (input.scanners.length > 0) details.push(`${input.scanners.length} src/ tree check(s)`);
      }
    } else {
      const { tests, via } = await throughReferences(path);
      verdict.tests.push(...tests);
      if (via.length > 0) details.push(`named in ${via.length} file(s): ${tests.length} test(s)`);
    }

    verdict.tests = [...new Set(verdict.tests)].sort();
    if (verdict.tests.length > 0) verdict.effect = 'tests';
    if (verdict.uncovered) details.push('NO TEST DEPENDS ON THIS FILE');
    if (verdict.tests.length === 0 && details.length === 0) {
      details.push(
        outside === undefined
          ? 'no Jest test depends on it'
          : 'no node/web Jest test depends on it',
      );
    }
    verdict.detail = details.join('; ');
  }

  const total = input.tests.length;
  if (fullBecause.length === 0 && total > 0 && selected.size / total >= FULL_THRESHOLD) {
    fullBecause.push(
      `${selected.size} of ${total} test files selected (≥ ${Math.round(FULL_THRESHOLD * 100)}%): running all`,
    );
  }

  if (fullBecause.length > 0) {
    /** @type {Map<string, string[]>} */
    const all = new Map();
    for (const test of input.tests) all.set(test.path, selected.get(test.path) ?? ['Full mode']);
    return { mode: 'full', fullBecause, files, selected: all, skipped: [], total };
  }

  const skipped = input.tests.map((t) => t.path).filter((path) => !selected.has(path));
  return {
    mode: selected.size === 0 ? 'none' : 'smart',
    fullBecause,
    files,
    selected: new Map([...selected].sort(([a], [b]) => a.localeCompare(b))),
    skipped,
    total,
  };
}
