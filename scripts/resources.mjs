// @ts-check
/**
 * How many Jest workers this machine can give the local tests right now (`npm test`,
 * `npm run check`). CI never comes here: it runs Jest exactly as it always did.
 *
 * Why this exists. Jest starts `cores - 1` workers by default, whatever the memory. Each worker
 * here runs ts-jest, which type-checks every test file and what it imports (no
 * `isolatedModules`), so each worker builds a TypeScript program of its own, and the `web`
 * project adds jsdom and React on top. A few such workers on a machine with little free memory
 * swap, and the whole machine — the editor, Claude Code, the board — slows down with them.
 *
 * The decision uses what the machine has free now, not only what it has installed: a 16 GB
 * machine with 500 MB available is not a powerful machine. Nothing is started or kept running
 * to find out (macOS: one `vm_stat`, only there, only when Jest is about to run).
 *
 * Profiles (thresholds and their reasons: docs/local-resources.md):
 *
 *   conservative  Jest runs in band: one process, no workers. When the machine cannot afford two
 *                 workers by memory or by idle cores, or when its resources cannot be read.
 *   balanced      Up to half of the idle cores, and never more than memory allows.
 *   performance   Up to every idle core but one, never more than memory allows. When memory and
 *                 idle cores allow at least PERFORMANCE_SLOTS workers each.
 *
 * Override: BOARD_RESOURCE_PROFILE=auto|conservative|balanced|performance. A Jest option of the
 * person's own (`npm test -- --maxWorkers=N`, `-i`, `--runInBand`) always wins and is left as is.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const MIB = 1024 * 1024;

/**
 * Memory one Jest worker is planned for at its peak: ts-jest's TypeScript program for the files
 * it runs, plus jsdom and React for `web` tests. Workers that keep more than WORKER_IDLE_LIMIT
 * after a test file are restarted by Jest, which holds them to this plan.
 */
export const WORKER_MIB = 1024;

/** Passed to Jest as `--workerIdleMemoryLimit` when it runs workers on a large set of tests. */
export const WORKER_IDLE_LIMIT = '768MB';

/**
 * Jest (30.5) runs up to 20 tests in band when it has timings of earlier runs and they were fast,
 * saving the cost of worker processes — but never when `workerIdleMemoryLimit` is set. So the
 * limit is only passed for runs that can be larger than this, or whose size is not known.
 */
export const SMALL_RUN_TESTS = 20;

/**
 * Memory always left to everything else — the OS, the editor, Claude Code, the board, and the
 * Jest parent process itself (which holds the haste map, and runs the tests in band):
 * at least RESERVE_MIN_MIB, and RESERVE_SHARE of the installed memory on larger machines.
 */
export const RESERVE_MIN_MIB = 1024;
export const RESERVE_SHARE = 0.1;

/** Fewer workers than this by memory or by idle cores: parallel runs cost more than they give. */
export const MIN_PARALLEL_SLOTS = 2;

/** At least this many workers by memory and by idle cores: room for real parallel work. */
export const PERFORMANCE_SLOTS = 6;

export const PROFILE_ENV = 'BOARD_RESOURCE_PROFILE';

/** @typedef {'conservative' | 'balanced' | 'performance'} Profile */
/** @type {readonly Profile[]} */
export const PROFILES = ['conservative', 'balanced', 'performance'];

/**
 * What the machine shows about itself. Any field may be missing: it could not be read.
 * @typedef {object} Resources
 * @property {number | undefined} totalBytes
 * @property {number | undefined} availableBytes  Memory a new process can get without swapping.
 * @property {number | undefined} cores           CPUs this process may use.
 * @property {number | undefined} load            1-minute load average; none where the OS has none.
 */

/**
 * What the OS offers, injected so that every platform can be tested on any other.
 * @typedef {object} SystemInfo
 * @property {NodeJS.Platform} platform
 * @property {() => number} totalmem
 * @property {() => number} freemem
 * @property {(() => number) | undefined} availableMemory  `process.availableMemory` (cgroups aware).
 * @property {() => number} availableParallelism
 * @property {() => number[]} loadavg
 * @property {() => string} vmStat  Output of macOS `vm_stat`.
 */

/** @type {SystemInfo} */
const realSystem = {
  platform: process.platform,
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  availableMemory:
    typeof process.availableMemory === 'function' ? () => process.availableMemory() : undefined,
  availableParallelism: () =>
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
  loadavg: () => os.loadavg(),
  vmStat: () => execFileSync('vm_stat', { encoding: 'utf8', timeout: 2000, stdio: 'pipe' }),
};

/** @param {unknown} value */
const positive = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/** @template T @param {() => T} read @returns {T | undefined} */
function attempt(read) {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Memory macOS can hand out: free, inactive and speculative pages. Its "free" alone
 * (`os.freemem`) leaves out the file cache it reclaims at once, and is often a few hundred MB
 * on a machine with gigabytes to spare.
 * @param {string} text  Output of `vm_stat`.
 * @returns {number | undefined}
 */
export function parseVmStat(text) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!positive(pageSize)) return undefined;
  /** @param {string} name */
  const pages = (name) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, 'm').exec(text)?.[1]);
  const free = pages('free');
  if (!Number.isFinite(free)) return undefined;
  const reclaimable = ['inactive', 'speculative']
    .map(pages)
    .filter(Number.isFinite)
    .reduce((sum, n) => sum + n, 0);
  return (free + reclaimable) * pageSize;
}

/**
 * Reads the machine. Never throws: what cannot be read is left out.
 *
 * - Linux: `process.availableMemory()` is MemAvailable, capped by a cgroup (container) limit.
 * - Windows: the same call is the available physical memory, standby cache included.
 * - macOS: `vm_stat`, since free memory alone undercounts (see parseVmStat).
 * - Load: Windows has no load average (Node reports zeros), so it is unknown there.
 * @param {SystemInfo} [system]
 * @returns {Resources}
 */
export function readResources(system = realSystem) {
  const totalBytes = positive(attempt(system.totalmem));
  let availableBytes = positive(
    attempt(() => (system.availableMemory ? system.availableMemory() : system.freemem())),
  );
  if (system.platform === 'darwin') {
    const fromVmStat = positive(attempt(() => parseVmStat(system.vmStat())));
    if (fromVmStat !== undefined) availableBytes = Math.max(availableBytes ?? 0, fromVmStat);
  }
  if (availableBytes !== undefined && totalBytes !== undefined) {
    availableBytes = Math.min(availableBytes, totalBytes);
  }
  const cores = positive(Math.floor(attempt(system.availableParallelism) ?? 0));
  const loadavg = system.platform === 'win32' ? undefined : attempt(system.loadavg);
  const load1 = loadavg?.[0];
  // All zeros is what Node reports where there is no load average at all.
  const load =
    typeof load1 === 'number' && Number.isFinite(load1) && load1 >= 0 && loadavg?.some((n) => n > 0)
      ? load1
      : undefined;
  return { totalBytes, availableBytes, cores, load };
}

/**
 * @typedef {object} Plan
 * @property {Profile} profile
 * @property {'auto' | 'env'} source
 * @property {number} workers     1 means in band.
 * @property {string} reason      Why this profile, in words.
 * @property {Resources} resources
 */

/**
 * Chooses the profile and the number of Jest workers. Pure: same input, same plan.
 * @param {Resources} resources
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ plan: Plan, warning?: string }}
 */
export function planResources(resources, env = {}) {
  // NaN, Infinity, zero and negative values mean "could not be read", never a number of workers.
  const totalBytes = positive(resources.totalBytes);
  const availableBytes = positive(resources.availableBytes);
  const cores = positive(Math.floor(resources.cores ?? 0));
  const load =
    typeof resources.load === 'number' && Number.isFinite(resources.load) && resources.load >= 0
      ? resources.load
      : undefined;
  const requested = (env[PROFILE_ENV] ?? '').trim().toLowerCase();
  /** @type {string | undefined} */
  let warning;
  /** @type {Profile | undefined} */
  let forced;
  if (requested !== '' && requested !== 'auto') {
    if (/** @type {readonly string[]} */ (PROFILES).includes(requested)) {
      forced = /** @type {Profile} */ (requested);
    } else {
      warning = `${PROFILE_ENV}=${requested} is not one of auto, ${PROFILES.join(', ')}; using auto.`;
    }
  }

  // Cores already busy with other work are not idle; without a load average none are counted.
  const idleCores =
    cores === undefined ? undefined : Math.max(0, cores - Math.min(cores, Math.round(load ?? 0)));
  const memorySlots =
    availableBytes === undefined || totalBytes === undefined
      ? undefined
      : Math.max(
          0,
          Math.floor(
            (availableBytes / MIB - Math.max(RESERVE_MIN_MIB, (totalBytes / MIB) * RESERVE_SHARE)) /
              WORKER_MIB,
          ),
        );

  /** @param {Profile} profile @param {number} memory  @param {number} idle */
  const workersOf = (profile, memory, idle) => {
    if (profile === 'conservative') return 1;
    const byCpu = profile === 'balanced' ? Math.floor(idle / 2) : idle - 1;
    return Math.max(1, Math.min(memory, byCpu));
  };

  if (forced !== undefined) {
    // The person chose: memory is not second-guessed; the cores still bound the workers.
    const idle = idleCores ?? cores ?? 1;
    const workers = workersOf(forced, Number.POSITIVE_INFINITY, idle);
    // Only said when the memory is known; a rough estimate, not a measurement.
    if (forced === 'performance' && memorySlots !== undefined && workers > memorySlots) {
      warning =
        `${PROFILE_ENV}=performance was chosen by hand: about ${workers} Jest workers are planned ` +
        `at ~${WORKER_MIB} MiB each, but by a rough estimate the free memory fits ${memorySlots}. ` +
        'The machine may run short of memory and swap. Continuing as chosen.';
    }
    return {
      plan: {
        profile: forced,
        source: 'env',
        workers,
        reason: `set by ${PROFILE_ENV}`,
        resources,
      },
      ...(warning === undefined ? {} : { warning }),
    };
  }

  /** @type {Profile} */
  let profile;
  let reason;
  if (memorySlots === undefined || idleCores === undefined) {
    profile = 'conservative';
    reason = 'the memory or CPUs of this machine could not be read';
  } else if (memorySlots < MIN_PARALLEL_SLOTS) {
    profile = 'conservative';
    reason = 'not enough free memory for parallel workers';
  } else if (idleCores < MIN_PARALLEL_SLOTS) {
    profile = 'conservative';
    reason = 'not enough idle CPU cores for parallel workers';
  } else if (memorySlots >= PERFORMANCE_SLOTS && idleCores >= PERFORMANCE_SLOTS) {
    profile = 'performance';
    reason = 'plenty of free memory and idle cores';
  } else {
    profile = 'balanced';
    reason = 'room for some parallel workers';
  }
  return {
    plan: {
      profile,
      source: 'auto',
      workers: workersOf(profile, memorySlots ?? 0, idleCores ?? 0),
      reason,
      resources,
    },
    ...(warning === undefined ? {} : { warning }),
  };
}

/** Long Jest options that say how many processes to use, in camelCase and kebab-case. */
const WORKER_LONG = new Set([
  '--maxWorkers',
  '--max-workers',
  '--runInBand',
  '--run-in-band',
  '--workerIdleMemoryLimit',
  '--worker-idle-memory-limit',
]);

/**
 * Whether one argument is a Jest option that already says how many processes to use:
 * `--maxWorkers=2`, `--max-workers 2`, `-w3`, `-w 3`, `-i`, `--runInBand`, … (the value of the
 * `-w 3` form is the next argument and needs no check of its own).
 * @param {string} arg
 */
const isWorkerOption = (arg) =>
  WORKER_LONG.has(arg.split('=')[0] ?? '') || arg === '-i' || /^-w(\d|=|$)/.test(arg);

/**
 * Whether the Jest command line already says how many processes to use.
 * @param {string[]} jestArgs
 */
export const hasWorkerOption = (jestArgs) => jestArgs.some(isWorkerOption);

/**
 * How many tests a Jest command line names by path (`--runTestsByPath a b c`), or undefined when
 * it selects them some other way and the size of the run is not known.
 * @param {string[]} jestArgs
 * @returns {number | undefined}
 */
function namedTests(jestArgs) {
  const at = jestArgs.indexOf('--runTestsByPath');
  if (at < 0) return undefined;
  return jestArgs.slice(at + 1).filter((arg) => !arg.startsWith('-')).length;
}

/**
 * The Jest options of a plan, or none when the command line already chose.
 * @param {Plan} plan
 * @param {string[]} jestArgs
 * @returns {string[]}
 */
export function jestWorkerArgs(plan, jestArgs) {
  if (hasWorkerOption(jestArgs)) return [];
  if (!Number.isInteger(plan.workers) || plan.workers <= 1) return ['--maxWorkers=1'];
  const tests = namedTests(jestArgs);
  // A small run keeps Jest's own in-band fast path, which the memory limit would switch off.
  return tests !== undefined && tests <= SMALL_RUN_TESTS
    ? [`--maxWorkers=${plan.workers}`]
    : [`--maxWorkers=${plan.workers}`, `--workerIdleMemoryLimit=${WORKER_IDLE_LIMIT}`];
}

/**
 * One line for the log of a run: what was seen, which profile, how many workers.
 * @param {Plan} plan
 */
export function describePlan(plan) {
  const { totalBytes, availableBytes, cores, load } = plan.resources;
  const gib = (/** @type {number | undefined} */ bytes) =>
    bytes === undefined ? '?' : (bytes / 1024 / MIB).toFixed(1);
  const seen = [
    `${gib(availableBytes)} of ${gib(totalBytes)} GiB available`,
    `${cores ?? '?'} CPU cores`,
    ...(load === undefined ? [] : [`load ${load.toFixed(1)}`]),
  ].join(', ');
  const jest = plan.workers <= 1 ? 'in band (one process)' : `up to ${plan.workers} workers`;
  return `Resources: ${plan.profile.toUpperCase()} (${plan.reason}) — ${seen}. Jest: ${jest}.`;
}
