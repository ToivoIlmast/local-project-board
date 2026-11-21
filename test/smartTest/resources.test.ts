import { jest } from '@jest/globals';
import {
  PROFILE_ENV,
  WORKER_IDLE_LIMIT,
  describePlan,
  hasWorkerOption,
  jestWorkerArgs,
  parseVmStat,
  planResources,
  readResources,
  type Resources,
  type SystemInfo,
} from '../../scripts/resources.mjs';

/**
 * How many Jest workers the local tests get (scripts/resources.mjs, docs/local-resources.md).
 * Every machine and every platform here is a stub: nothing is measured and nothing is loaded.
 */
const GIB = 1024 ** 3;

const machine = (
  totalGib: number,
  availableGib: number,
  cores: number,
  load?: number,
): Resources => ({
  totalBytes: totalGib * GIB,
  availableBytes: availableGib * GIB,
  cores,
  load,
});

const system = (overrides: Partial<SystemInfo>): SystemInfo => ({
  platform: 'linux',
  totalmem: () => 16 * GIB,
  freemem: () => 1 * GIB,
  availableMemory: () => 10 * GIB,
  availableParallelism: () => 8,
  loadavg: () => [0.5, 0.4, 0.3],
  vmStat: () => {
    throw new Error('vm_stat must not be called off macOS');
  },
  ...overrides,
});

describe('the profile follows what the machine has free now, not what it has installed', () => {
  it.each([
    // total, available, cores, load → profile, workers
    [4, 0.3, 4, undefined, 'conservative', 1],
    [4, 2.5, 4, undefined, 'conservative', 1],
    [8, 4, 4, undefined, 'balanced', 2],
    [8, 4, 8, undefined, 'balanced', 3],
    [16, 0.5, 8, undefined, 'conservative', 1],
    [16, 10, 8, undefined, 'performance', 7],
    [32, 24, 16, undefined, 'performance', 15],
    [32, 8, 16, undefined, 'balanced', 4],
    [64, 50, 32, undefined, 'performance', 31],
  ] as const)(
    '%d GiB total, %d GiB available, %d cores → %s, %d worker(s)',
    (total, available, cores, load, profile, workers) => {
      const { plan } = planResources(machine(total, available, cores, load));
      expect(plan.profile).toBe(profile);
      expect(plan.workers).toBe(workers);
      expect(plan.source).toBe('auto');
    },
  );

  it('a large machine whose cores are busy is not a fast machine right now', () => {
    expect(planResources(machine(32, 20, 16, 12)).plan).toMatchObject({
      profile: 'balanced',
      workers: 2,
    });
    expect(planResources(machine(32, 20, 16, 15.2)).plan).toMatchObject({
      profile: 'conservative',
      workers: 1,
    });
  });

  it('memory bounds the workers even when the cores would allow more', () => {
    // 4 GiB available, 1.6 GiB kept back: two workers of 1 GiB each.
    expect(planResources(machine(16, 4, 16)).plan).toMatchObject({
      profile: 'balanced',
      workers: 2,
    });
  });

  it('a single core is never parallel', () => {
    expect(planResources(machine(16, 12, 1)).plan.workers).toBe(1);
  });
});

describe('what cannot be read is the safe fallback: conservative', () => {
  it.each([
    ['memory', { ...machine(16, 10, 8), availableBytes: undefined }],
    ['total memory', { ...machine(16, 10, 8), totalBytes: undefined }],
    ['CPUs', { ...machine(16, 10, 8), cores: undefined }],
    [
      'anything',
      { totalBytes: undefined, availableBytes: undefined, cores: undefined, load: undefined },
    ],
  ])('without %s', (_what, resources: Resources) => {
    const { plan } = planResources(resources);
    expect(plan.profile).toBe('conservative');
    expect(plan.workers).toBe(1);
    expect(plan.reason).toContain('could not be read');
  });

  it('a system whose every call throws gives nothing, not an error', () => {
    const fail = (): never => {
      throw new Error('no');
    };
    const resources = readResources(
      system({
        totalmem: fail,
        freemem: fail,
        availableMemory: fail,
        availableParallelism: fail,
        loadavg: fail,
      }),
    );
    expect(resources).toEqual({
      totalBytes: undefined,
      availableBytes: undefined,
      cores: undefined,
      load: undefined,
    });
    expect(planResources(resources).plan.profile).toBe('conservative');
  });
});

describe('a profile chosen by hand that the free memory cannot carry', () => {
  const env = { [PROFILE_ENV]: 'performance' };

  it('warns, as an estimate, and still runs Performance', () => {
    const { plan, warning } = planResources(machine(16, 3, 8), env);
    expect(plan).toMatchObject({ profile: 'performance', workers: 7, source: 'env' });
    expect(warning).toContain('chosen by hand');
    expect(warning).toContain('7 Jest workers');
    expect(warning).toContain('rough estimate');
  });

  it('no warning when memory fits, or when memory is unknown', () => {
    expect(planResources(machine(32, 20, 8), env).warning).toBeUndefined();
    const unknown = { totalBytes: undefined, availableBytes: undefined, cores: 8, load: undefined };
    expect(planResources(unknown, env).warning).toBeUndefined();
  });

  it('no warning for the other chosen profiles, and none in auto', () => {
    expect(planResources(machine(16, 3, 8), { [PROFILE_ENV]: 'balanced' }).warning).toBeUndefined();
    expect(planResources(machine(16, 3, 8)).warning).toBeUndefined();
  });
});

describe('values that are not numbers of a machine are never workers', () => {
  const bad = [Number.NaN, Number.POSITIVE_INFINITY, -4, 0];

  it.each(bad)('cores %s: conservative, one worker', (cores) => {
    const { plan } = planResources({ ...machine(16, 10, 8), cores });
    expect(plan).toMatchObject({ profile: 'conservative', workers: 1 });
  });

  it.each(bad)('available memory %s: conservative, one worker', (value) => {
    const { plan } = planResources({ ...machine(16, 10, 8), availableBytes: value });
    expect(plan).toMatchObject({ profile: 'conservative', workers: 1 });
  });

  it.each(bad)('load %s never makes a NaN count', (load) => {
    const { plan } = planResources({ ...machine(16, 10, 8), load });
    expect(Number.isInteger(plan.workers)).toBe(true);
    expect(jestWorkerArgs(plan, []).join(' ')).not.toMatch(/NaN|Infinity|-d/);
  });

  it.each(bad)('a forced profile with cores %s still gives a whole number', (cores) => {
    const { plan } = planResources(
      { ...machine(16, 10, 8), cores },
      { [PROFILE_ENV]: 'performance' },
    );
    expect(Number.isInteger(plan.workers) && plan.workers >= 1).toBe(true);
  });
});

describe('the person can choose the profile', () => {
  it.each([
    ['conservative', 1],
    ['balanced', 4],
    ['performance', 7],
  ] as const)('%s, set in the environment, wins over what is free', (profile, workers) => {
    // Little memory: auto would say conservative.
    const { plan } = planResources(machine(16, 0.5, 8), {
      [PROFILE_ENV]: ` ${profile.toUpperCase()} `,
    });
    expect(plan).toMatchObject({ profile, workers, source: 'env' });
  });

  it('auto and an empty value are automatic', () => {
    for (const value of ['auto', '', 'AUTO']) {
      expect(planResources(machine(16, 10, 8), { [PROFILE_ENV]: value }).plan.source).toBe('auto');
    }
  });

  it('an unknown value is said, and auto is used', () => {
    const { plan, warning } = planResources(machine(16, 10, 8), { [PROFILE_ENV]: 'turbo' });
    expect(plan.source).toBe('auto');
    expect(plan.profile).toBe('performance');
    expect(warning).toContain('turbo');
  });
});

describe('reading the machine on each platform', () => {
  it('Linux: the available memory is process.availableMemory (MemAvailable, cgroup limits)', () => {
    expect(readResources(system({}))).toEqual({
      totalBytes: 16 * GIB,
      availableBytes: 10 * GIB,
      cores: 8,
      load: 0.5,
    });
  });

  it('without process.availableMemory, os.freemem is used', () => {
    expect(readResources(system({ availableMemory: undefined })).availableBytes).toBe(1 * GIB);
  });

  it('Windows: no load average (Node reports zeros), so the load is unknown, not zero', () => {
    const loadavg = jest.fn(() => [0, 0, 0]);
    const resources = readResources(system({ platform: 'win32', loadavg }));
    expect(resources.load).toBeUndefined();
    expect(loadavg).not.toHaveBeenCalled();
    expect(resources.availableBytes).toBe(10 * GIB);
  });

  it('a load average of all zeros elsewhere is unknown too', () => {
    expect(readResources(system({ loadavg: () => [0, 0, 0] })).load).toBeUndefined();
  });

  const VM_STAT = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                               10000.',
    'Pages active:                            300000.',
    'Pages inactive:                          200000.',
    'Pages speculative:                        40000.',
    'Pages throttled:                              0.',
    'Pages wired down:                        150000.',
    'Pages purgeable:                          20000.',
  ].join('\n');

  it('macOS: free + inactive + speculative pages of vm_stat', () => {
    expect(parseVmStat(VM_STAT)).toBe((10000 + 200000 + 40000) * 16384);
    const resources = readResources(
      system({ platform: 'darwin', availableMemory: () => 0.15 * GIB, vmStat: () => VM_STAT }),
    );
    expect(resources.availableBytes).toBe((10000 + 200000 + 40000) * 16384);
  });

  it('macOS: a vm_stat that fails or says nothing useful leaves the free memory', () => {
    const fails = readResources(
      system({
        platform: 'darwin',
        availableMemory: () => 0.5 * GIB,
        vmStat: () => {
          throw new Error('ENOENT');
        },
      }),
    );
    expect(fails.availableBytes).toBe(0.5 * GIB);
    expect(parseVmStat('nothing here')).toBeUndefined();
  });

  it('available memory is never more than the installed memory', () => {
    expect(readResources(system({ availableMemory: () => 64 * GIB })).availableBytes).toBe(
      16 * GIB,
    );
  });
});

describe('the Jest options of a plan', () => {
  const plan = (workers: number) => ({ ...planResources(machine(16, 10, 8)).plan, workers });

  it('one worker: in band, no worker processes at all', () => {
    expect(jestWorkerArgs(plan(1), [])).toEqual(['--maxWorkers=1']);
  });

  it('several: the count, and workers that grow too large are restarted', () => {
    expect(jestWorkerArgs(plan(3), ['--silent'])).toEqual([
      '--maxWorkers=3',
      `--workerIdleMemoryLimit=${WORKER_IDLE_LIMIT}`,
    ]);
  });

  it.each([
    '--maxWorkers=2',
    '--maxWorkers 2',
    '--max-workers=2',
    '--max-workers 2',
    '--runInBand',
    '--run-in-band',
    '-w3',
    '-w 3',
    '-w=3',
    '-i',
    '--workerIdleMemoryLimit=512MB',
    '--workerIdleMemoryLimit 512MB',
    '--worker-idle-memory-limit=512MB',
    '--worker-idle-memory-limit 512MB',
  ])('the person’s own %s stands', (own) => {
    expect(hasWorkerOption(['test/a.test.ts', ...own.split(' ')])).toBe(true);
    expect(jestWorkerArgs(plan(3), ['test/a.test.ts', ...own.split(' ')])).toEqual([]);
  });

  it.each([
    '--silent',
    '-t',
    '--watch',
    '--ci',
    '-wat',
    '--maxWorkersX=2',
    '--inband',
    'test/w3.test.ts',
  ])('%s is not a worker option', (arg) => {
    expect(hasWorkerOption([arg])).toBe(false);
  });

  it('a small named run keeps Jest’s in-band fast path: no idle memory limit', () => {
    const paths = Array.from({ length: 20 }, (_, i) => `test/t${i}.test.ts`);
    expect(jestWorkerArgs(plan(3), ['--runTestsByPath', ...paths])).toEqual(['--maxWorkers=3']);
  });

  it('a larger or unknown-size run keeps the limit', () => {
    const paths = Array.from({ length: 21 }, (_, i) => `test/t${i}.test.ts`);
    const limited = ['--maxWorkers=3', `--workerIdleMemoryLimit=${WORKER_IDLE_LIMIT}`];
    expect(jestWorkerArgs(plan(3), ['--runTestsByPath', ...paths])).toEqual(limited);
    expect(jestWorkerArgs(plan(3), [])).toEqual(limited);
  });

  it('one line says what was seen and what was chosen', () => {
    expect(describePlan(planResources(machine(8, 4, 4, 0.4)).plan)).toBe(
      'Resources: BALANCED (room for some parallel workers) — 4.0 of 8.0 GiB available, ' +
        '4 CPU cores, load 0.4. Jest: up to 2 workers.',
    );
    expect(describePlan(planResources(machine(4, 0.3, 4)).plan)).toBe(
      'Resources: CONSERVATIVE (not enough free memory for parallel workers) — 0.3 of 4.0 GiB ' +
        'available, 4 CPU cores. Jest: in band (one process).',
    );
  });
});
