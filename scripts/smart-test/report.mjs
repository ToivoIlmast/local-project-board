// @ts-check
/**
 * What the person running the tests reads: the mode, why, what changed, which tests run and
 * why, and how many do not. A Smart run never reads like a full check; that sentence is in the
 * header and again in the footer, below Jest's own output.
 */

/**
 * @typedef {import('./plan.mjs').Plan} Plan
 * @typedef {import('./changes.mjs').ChangesFound} ChangesFound
 * @typedef {{
 *   kind: 'plan',
 *   plan: Plan,
 *   changes: ChangesFound | undefined,
 *   tests: import('./jest.mjs').TestFile[],
 *   listSkipped: boolean,
 * } | {
 *   kind: 'forced-full',
 *   why: string,
 * } | {
 *   kind: 'manual',
 *   args: string[],
 * }} Decision
 */

const RULE = '━'.repeat(72);
const NOT_FULL = 'This is NOT a full check of the project: `npm run test:full` runs every test.';
const ELSEWHERE =
  'Not part of `npm test` in any mode: Playwright (`npm run test:e2e`) and the package test ' +
  '(`npm run test:pack`); CI runs both.';

/**
 * @param {Decision} decision
 * @returns {string[]}
 */
export function header(decision) {
  if (decision.kind === 'forced-full') {
    return [
      RULE,
      `Tests: FULL mode — ${decision.why}.`,
      'Every test of the `node` and `web` Jest projects runs; no change detection is used.',
      RULE,
    ];
  }
  if (decision.kind === 'manual') {
    return [
      RULE,
      `Tests: MANUAL selection — Jest runs what you asked for: ${decision.args.join(' ')}`,
      'Smart mode is off for this run. ' + NOT_FULL,
      RULE,
    ];
  }

  const { plan, changes } = decision;
  const lines = [RULE];
  if (plan.mode === 'full') {
    lines.push(
      `Tests: FULL mode — Smart mode widened to every test (${plan.total} files), because:`,
    );
    for (const why of plan.fullBecause) lines.push(`  • ${why}`);
  } else if (plan.mode === 'none') {
    lines.push('Tests: SMART mode — NO TEST RUNS: no change reaches a node/web Jest test.');
    lines.push(NOT_FULL);
  } else {
    lines.push('Tests: SMART mode — only the tests your changes can reach.');
    lines.push(NOT_FULL);
  }

  if (changes !== undefined) {
    const commits = changes.commits === 1 ? '1 commit' : `${changes.commits} commits`;
    lines.push(
      '',
      `Changes: ${changes.changes.length} file(s) — ${commits} since \`${changes.base}\` ` +
        `(merge base ${changes.mergeBase.slice(0, 8)}), plus uncommitted and untracked files`,
    );
    for (const note of changes.notes) lines.push(`  ! ${note}`);
  } else {
    lines.push('', `Changes: ${plan.files.length} file(s) named with --changed (git was not read)`);
  }
  const statusWord = { A: 'added  ', M: 'changed', D: 'deleted' };
  for (const file of plan.files) {
    lines.push(`  ${statusWord[file.change.status]} ${file.change.path} — ${file.detail}`);
    if (file.outside !== undefined) lines.push(`          also checked by ${file.outside}`);
  }
  const uncovered = plan.files.filter((f) => f.uncovered);
  if (uncovered.length > 0) {
    lines.push('', `! ${uncovered.length} changed source file(s) are not reached by any test:`);
    for (const file of uncovered) lines.push(`    ${file.change.path}`);
  }

  if (plan.mode === 'smart') {
    const byProject = countByProject(decision.tests, [...plan.selected.keys()]);
    lines.push('', `Selected: ${plan.selected.size} of ${plan.total} test files (${byProject})`);
    for (const [test, why] of plan.selected) {
      const more = why.length > 1 ? ` (+${why.length - 1} more)` : '';
      lines.push(`  ${test} — ${why[0]}${more}`);
    }
    lines.push('', `Not run: ${plan.skipped.length} test files.`);
    if (decision.listSkipped) for (const test of plan.skipped) lines.push(`  ${test}`);
    else if (plan.skipped.length > 0) lines.push('  (`npm test -- --list-skipped` lists them)');
  }
  lines.push(ELSEWHERE, RULE);
  return lines;
}

/**
 * What a `--never-full` run prints instead of starting a Full run.
 * @param {Decision} decision  a Full decision: forced, or a plan widened to every test
 * @returns {string[]}
 */
export function skippedFull(decision) {
  /** @type {string[]} */
  let reasons = [];
  if (decision.kind === 'forced-full') reasons = [decision.why];
  else if (decision.kind === 'plan') reasons = decision.plan.fullBecause;
  return [
    RULE,
    '! Tests: SKIPPED — JEST WAS NOT RUN. Smart mode would widen to every test, because:',
    ...reasons.map((why) => `  • ${why}`),
    '--never-full never starts a Full run. No test has checked this change locally: CI runs ' +
      'every test, or run `npm run test:full` (or `npm test -- --full`) yourself.',
    RULE,
  ];
}

/**
 * The last lines, after Jest's own summary.
 * @param {Decision} decision
 * @param {number | null} exitCode
 * @returns {string[]}
 */
export function footer(decision, exitCode) {
  const outcome = exitCode === 0 ? 'passed' : 'FAILED';
  if (decision.kind === 'forced-full') {
    return [RULE, `Tests: FULL mode ${outcome}: every node and web test file ran.`, RULE];
  }
  if (decision.kind === 'manual') {
    return [RULE, `Tests: MANUAL selection ${outcome}. ${NOT_FULL}`, RULE];
  }
  const { plan } = decision;
  if (plan.mode === 'full') {
    return [RULE, `Tests: FULL mode ${outcome}: all ${plan.total} test files ran.`, RULE];
  }
  return [
    RULE,
    `Tests: SMART mode ${outcome}: ${plan.selected.size} of ${plan.total} test files ran, ` +
      `${plan.skipped.length} did not.`,
    NOT_FULL,
    RULE,
  ];
}

/**
 * @param {import('./jest.mjs').TestFile[]} tests
 * @param {string[]} paths
 */
function countByProject(tests, paths) {
  const projectOf = new Map(tests.map((t) => [t.path, t.project]));
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const path of paths) {
    const project = projectOf.get(path) ?? '?';
    counts.set(project, (counts.get(project) ?? 0) + 1);
  }
  return [...counts].map(([project, n]) => `${project} ${n}`).join(', ');
}

/**
 * The plan as data, for `--plan --json`: what tests and tools can read.
 * @param {Decision} decision
 */
export function toJson(decision) {
  if (decision.kind !== 'plan') return decision;
  const { plan, changes } = decision;
  return {
    kind: 'plan',
    mode: plan.mode,
    fullBecause: plan.fullBecause,
    base: changes?.base,
    mergeBase: changes?.mergeBase,
    notes: changes?.notes ?? [],
    files: plan.files.map((f) => ({
      status: f.change.status,
      path: f.change.path,
      effect: f.effect,
      detail: f.detail,
      tests: f.tests,
      outside: f.outside,
      uncovered: f.uncovered,
    })),
    selected: Object.fromEntries(plan.selected),
    skipped: plan.skipped,
    total: plan.total,
  };
}
