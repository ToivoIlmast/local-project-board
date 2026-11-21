// @ts-check
/**
 * `npm test`: the one way tests are started in this repository — by a person in a terminal, by
 * Claude Code, by a Board Runner task. Smart mode by default, Full mode on request, always Full
 * under CI. `npm run test:full` does not come here at all: it is the plain Jest command.
 *
 *   npm test                         Smart mode
 *   npm test -- --full               Full mode (same as `npm run test:full`)
 *   npm test -- --never-full         Smart mode, but a run that would be Full starts no Jest:
 *                                    it says why and exits with SKIPPED_FULL_EXIT (`npm run check`)
 *   npm test -- --plan [--json]      only print what would run and why
 *   npm test -- --list-skipped       also list the tests that will not run
 *   npm test -- --base <ref>         compare with <ref> instead of the detected base branch
 *   npm test -- --changed <path>     pretend <path> changed (repeatable); git is not read
 *   npm test -- <file|pattern> | -t  MANUAL: Jest runs exactly what you named
 */
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectChanges, referencesIn } from './changes.mjs';
import { loadJest } from './jest.mjs';
import { planTests } from './plan.mjs';
import { footer, header, skippedFull, toJson } from './report.mjs';
import { FULL_JEST_ARGS, JEST_BIN_ARGS, PROJECT_ARGS } from './rules.mjs';
import {
  describePlan,
  hasWorkerOption,
  jestWorkerArgs,
  planResources,
  readResources,
} from '../resources.mjs';
import { runChild } from '../run-child.mjs';

/**
 * The exit code of a `--never-full` run that would have been Full and so started no Jest:
 * neither a pass (0) nor a test failure (1), so a caller can tell the tests were not run.
 */
export const SKIPPED_FULL_EXIT = 3;

/**
 * @typedef {import('./report.mjs').Decision} Decision
 * @typedef {object} Options
 * @property {boolean} full
 * @property {boolean} neverFull   A run that would be Full is skipped instead (unless --full).
 * @property {boolean} plan
 * @property {boolean} json
 * @property {boolean} listSkipped
 * @property {boolean} help
 * @property {string | undefined} base
 * @property {string[]} changed
 * @property {string[]} jestFlags      Passed on to Jest in every mode (`--silent`, `--coverage`…).
 * @property {string[]} selection      Arguments that choose tests: they make the run MANUAL.
 */

/** Jest options that choose which tests run. Any of them hands the choice to the person. */
const SELECTION_FLAGS = new Set([
  '-t',
  '--testNamePattern',
  '--testPathPatterns',
  '--testPathPattern',
  '--testPathIgnorePatterns',
  '--selectProjects',
  '--ignoreProjects',
  '--runTestsByPath',
  '--findRelatedTests',
  '-o',
  '--onlyChanged',
  '--changedSince',
  '--lastCommit',
  '-f',
  '--onlyFailures',
  '--watch',
  '--watchAll',
  '--listTests',
  '--shard',
]);

/** Jest options whose value is the next argument, so that value is not taken for a test path. */
const VALUE_FLAGS = new Set([
  '-t',
  '--testNamePattern',
  '--testPathPatterns',
  '--testPathPattern',
  '--testPathIgnorePatterns',
  '--changedSince',
  '--shard',
  '-w',
  '--maxWorkers',
  '--testTimeout',
  '--seed',
  '--reporters',
  '--outputFile',
  '--coverageDirectory',
  '--coverageReporters',
  '--cacheDirectory',
  '--maxConcurrency',
]);

/**
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const options = {
    full: false,
    neverFull: false,
    plan: false,
    json: false,
    listSkipped: false,
    help: false,
    base: undefined,
    changed: [],
    jestFlags: [],
    selection: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [name = '', inline] = arg.startsWith('--') ? arg.split(/=(.*)/s, 2) : [arg];
    /** @returns {string} */
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new Error(`${name} needs a value`);
      return next;
    };
    if (name === '--full') options.full = true;
    else if (name === '--smart') options.full = false;
    else if (name === '--never-full') options.neverFull = true;
    else if (name === '--plan') options.plan = true;
    else if (name === '--json') options.json = true;
    else if (name === '--list-skipped') options.listSkipped = true;
    else if (name === '--help' || name === '-h') options.help = true;
    else if (name === '--base') options.base = value();
    else if (name === '--changed') options.changed.push(value().replaceAll('\\', '/'));
    else if (!arg.startsWith('-')) options.selection.push(arg);
    else {
      const takesValue = VALUE_FLAGS.has(name) && inline === undefined && i + 1 < argv.length;
      const group = takesValue ? [arg, argv[++i] ?? ''] : [arg];
      if (SELECTION_FLAGS.has(name)) options.selection.push(...group);
      else options.jestFlags.push(...group);
    }
  }
  return options;
}

/**
 * CI is recognised however it is spelled by the CI service; no local setting can turn it off.
 * @param {NodeJS.ProcessEnv} env
 */
export function isCi(env) {
  const ci = (env['CI'] ?? '').trim().toLowerCase();
  return (ci !== '' && ci !== 'false' && ci !== '0') || env['GITHUB_ACTIONS'] === 'true';
}

/**
 * @typedef {object} DecideDeps
 * @property {typeof collectChanges} collectChanges
 * @property {typeof loadJest} loadJest
 * @property {(root: string) => (token: string) => Promise<string[]>} referencesIn
 * @property {(path: string) => boolean} exists
 */

/** @type {DecideDeps} */
const realDeps = {
  collectChanges,
  loadJest,
  referencesIn,
  exists: existsSync,
};

/**
 * What this run is: Full, Manual, or a Smart plan (which may itself widen to Full).
 * @param {{ options: Options, env: NodeJS.ProcessEnv, root: string, deps?: DecideDeps }} input
 * @returns {Promise<{ decision: Decision, warnings: string[] }>}
 */
export async function decide({ options, env, root, deps = realDeps }) {
  /** @type {string[]} */
  const warnings = [];
  const ignoreSelection = (/** @type {string} */ why) => {
    if (options.selection.length > 0) {
      warnings.push(`${why}: ignoring the test selection ${options.selection.join(' ')}`);
    }
  };

  if (isCi(env)) {
    ignoreSelection('CI runs every test');
    return { decision: { kind: 'forced-full', why: 'CI always runs every test' }, warnings };
  }
  if (options.full) {
    ignoreSelection('--full runs every test');
    return { decision: { kind: 'forced-full', why: 'requested with --full' }, warnings };
  }
  if (options.selection.length > 0) {
    return { decision: { kind: 'manual', args: options.selection }, warnings };
  }

  /** @type {import('./changes.mjs').ChangesFound | undefined} */
  let found;
  /** @type {import('./changes.mjs').Change[]} */
  let changes;
  if (options.changed.length > 0) {
    changes = options.changed.map((path) => ({
      status: deps.exists(join(root, path)) ? 'M' : 'D',
      path,
    }));
  } else {
    const result = await deps.collectChanges({ root, base: options.base });
    if (!result.ok) {
      return {
        decision: {
          kind: 'forced-full',
          why: `Smart mode cannot tell what changed: ${result.reason}`,
        },
        warnings,
      };
    }
    found = result;
    changes = result.changes;
  }

  try {
    const jest = await deps.loadJest(root);
    const plan = await planTests({
      changes,
      tests: jest.tests,
      related: jest.related,
      projectWide: jest.projectWide,
      scanners: jest.scanners,
      references: deps.referencesIn(root),
    });
    return {
      decision: {
        kind: 'plan',
        plan,
        changes: found,
        tests: jest.tests,
        listSkipped: options.listSkipped,
      },
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return {
      decision: {
        kind: 'forced-full',
        why: `Smart mode could not relate changes to tests (${message})`,
      },
      warnings,
    };
  }
}

/**
 * Whether a decision runs every test.
 * @param {Decision} decision
 */
export function isFull(decision) {
  return (
    decision.kind === 'forced-full' || (decision.kind === 'plan' && decision.plan.mode === 'full')
  );
}

/**
 * The Jest command line for a decision, or null when no test is to run.
 * @param {Decision} decision
 * @param {Options} options
 * @returns {string[] | null}
 */
export function jestArgv(decision, options) {
  if (decision.kind === 'forced-full') return [...FULL_JEST_ARGS, ...options.jestFlags];
  if (decision.kind === 'manual') {
    // The selection may start with a path: after `--selectProjects` it would be taken for one
    // more project and every test would run. The project list goes last, where nothing follows.
    return [...JEST_BIN_ARGS, ...options.selection, ...options.jestFlags, ...PROJECT_ARGS];
  }
  const { plan } = decision;
  if (plan.mode === 'none') return null;
  if (plan.mode === 'full') return [...FULL_JEST_ARGS, ...options.jestFlags];
  return [...FULL_JEST_ARGS, ...options.jestFlags, '--runTestsByPath', ...plan.selected.keys()];
}

/**
 * @param {{ argv: string[], env: NodeJS.ProcessEnv, root?: string,
 *   out?: (line: string) => void,
 *   run?: (args: string[], root: string) => number | null | Promise<number | null>,
 *   deps?: DecideDeps }} io
 * @returns {Promise<number>}
 */
export async function main({
  argv,
  env,
  root = realpathSync.native(fileURLToPath(new URL('../..', import.meta.url))),
  out = (line) => process.stdout.write(`${line}\n`),
  run = (args, at) => runJest(args, at, env, out),
  deps = realDeps,
}) {
  /** @type {Options} */
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    out(`npm test: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (options.help) {
    out(USAGE);
    return 0;
  }

  const { decision, warnings } = await decide({ options, env, root, deps });
  for (const warning of warnings) out(`! ${warning}`);

  if (options.plan) {
    if (options.json) out(JSON.stringify(toJson(decision), null, 2));
    else for (const line of header(decision)) out(line);
    return 0;
  }

  // An explicit --full is a request and always wins; every other way to Full is automatic.
  if (options.neverFull && !options.full && isFull(decision)) {
    for (const line of skippedFull(decision)) out(line);
    return SKIPPED_FULL_EXIT;
  }

  for (const line of header(decision)) out(line);
  const args = jestArgv(decision, options);
  if (args === null) return 0;
  const code = await run(args, root);
  for (const line of footer(decision, code)) out(line);
  return code ?? 1;
}

/**
 * The Jest command line with the workers this machine can afford now (scripts/resources.mjs),
 * placed right after the Jest binary. Unchanged under CI, and when the command line already says
 * how many processes to use.
 * @param {string[]} args  A command line from `jestArgv`.
 * @param {NodeJS.ProcessEnv} env
 * @param {(line: string) => void} out
 * @param {() => import('../resources.mjs').Resources} [read]
 * @returns {string[]}
 */
export function withWorkerLimit(args, env, out, read = readResources) {
  const own = args.slice(JEST_BIN_ARGS.length);
  // Neither CI nor a choice of the person's own needs the machine to be read at all.
  if (isCi(env) || hasWorkerOption(own)) return args;
  const { plan, warning } = planResources(read(), env);
  const extra = jestWorkerArgs(plan, own);
  if (warning !== undefined) out(`! ${warning}`);
  if (extra.length === 0) return args;
  out(describePlan(plan));
  return [...JEST_BIN_ARGS, ...extra, ...own];
}

/**
 * Starts Jest and waits for it; a stop of this process is passed on to Jest (scripts/run-child.mjs).
 * @param {string[]} args
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 * @param {(line: string) => void} out
 */
function runJest(args, root, env, out) {
  return runChild(process.execPath, withWorkerLimit(args, env, out), { cwd: root });
}

const USAGE = `npm test — Smart mode: only the tests your changes can reach (docs/adr/0033).

  npm test                          Smart mode (CI: always Full mode)
  npm run test:full                 every test of the node and web projects
  npm test -- --full                the same, through this runner
  npm test -- --never-full          Smart mode; a run that would be Full is skipped, not run
  npm test -- --plan [--json]       show what would run and why; run nothing
  npm test -- --list-skipped        also list the tests that will not run
  npm test -- --base <ref>          compare with <ref> (default: origin/HEAD, main, master)
  npm test -- --changed <path>      treat <path> as changed instead of reading git (repeatable)
  npm test -- <path|pattern>, -t …  MANUAL: Jest runs exactly what you name
Any other Jest option (--silent, --coverage, …) is passed on to Jest.`;
