import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ESLINT_ARGS,
  PRETTIER_ARGS,
  TEST_ARGS,
  main as check,
} from '../../scripts/check-changed.mjs';
import type { decide } from '../../scripts/smart-test/cli.mjs';
import { main as runner, SKIPPED_FULL_EXIT } from '../../scripts/smart-test/cli.mjs';
import { FULL_JEST_ARGS } from '../../scripts/smart-test/rules.mjs';

/**
 * `npm run check` is the fast local default: it never starts a Full Jest run on its own
 * (`npm test -- --never-full`). A change that would widen Smart mode to every test leaves the
 * tests to CI and says so; Prettier and ESLint still run on the changed files.
 */
const TESTS = Array.from({ length: 10 }, (_, i) => ({
  path: `test/t${i}.test.ts`,
  project: 'node',
}));

type Deps = NonNullable<Parameters<typeof decide>[0]['deps']>;

const changed =
  (...paths: string[]): Deps['collectChanges'] =>
  async () => ({
    ok: true,
    changes: paths.map((path) => ({ status: 'M' as const, path })),
    base: 'origin/main',
    mergeBase: '0123456789abcdef',
    commits: 1,
    notes: [],
  });

const runnerDeps = (collectChanges: Deps['collectChanges']): Deps => ({
  collectChanges,
  loadJest: async () => ({
    tests: TESTS,
    related: async (paths: string[]) => (paths.includes('src/a.ts') ? ['test/t1.test.ts'] : []),
    projectWide: new Map(),
    scanners: [],
  }),
  referencesIn: () => async () => [],
  exists: () => true,
});

async function runTests(argv: string[], collectChanges: Deps['collectChanges'], env = {}) {
  const lines: string[] = [];
  const ran: string[][] = [];
  const code = await runner({
    argv,
    env,
    root: '/repo',
    out: (line) => lines.push(line),
    run: (args) => {
      ran.push(args);
      return 0;
    },
    deps: runnerDeps(collectChanges),
  });
  return { code, ran, text: lines.join('\n') };
}

describe('`npm test -- --never-full`: the tests of `npm run check`', () => {
  it('an ordinary source change runs only the relevant tests', async () => {
    const { code, ran, text } = await runTests(['--never-full'], changed('src/a.ts'));
    expect(code).toBe(0);
    expect(ran).toEqual([[...FULL_JEST_ARGS, '--runTestsByPath', 'test/t1.test.ts']]);
    expect(text).toContain('SMART mode passed: 1 of 10 test files ran, 9 did not.');
  });

  it.each([
    ['package.json', 'npm scripts or dependencies'],
    ['package-lock.json', 'locked dependency versions'],
    ['jest.config.js', 'Jest'],
    ['tsconfig.test.json', 'TypeScript configuration'],
  ])('a change to %s starts no Jest and says why, with a warning', async (path, reason) => {
    const { code, ran, text } = await runTests(['--never-full'], changed('src/a.ts', path));
    expect(ran).toEqual([]);
    expect(code).toBe(SKIPPED_FULL_EXIT);
    expect(text).toContain('! Tests: SKIPPED — JEST WAS NOT RUN.');
    expect(text).toContain(reason);
    expect(text).toContain('`npm run test:full`');
    expect(text).not.toContain('FULL mode');
  });

  it('git that cannot answer starts no Jest either', async () => {
    const { code, ran, text } = await runTests(['--never-full'], async () => ({
      ok: false,
      reason: 'not a git checkout',
    }));
    expect(ran).toEqual([]);
    expect(code).toBe(SKIPPED_FULL_EXIT);
    expect(text).toContain('not a git checkout');
  });

  it('an explicit --full still runs every test', async () => {
    const { code, ran } = await runTests(['--never-full', '--full'], changed('package.json'));
    expect(code).toBe(0);
    expect(ran).toEqual([FULL_JEST_ARGS]);
  });

  it('without --never-full, `npm test` keeps widening to Full as before', async () => {
    const { ran, text } = await runTests([], changed('package.json'));
    expect(ran).toEqual([FULL_JEST_ARGS]);
    expect(text).toContain('Tests: FULL mode — Smart mode widened to every test');
  });

  it('`npm test -- --full` runs every test', async () => {
    const { ran } = await runTests(['--full'], changed('src/a.ts'));
    expect(ran).toEqual([FULL_JEST_ARGS]);
  });
});

describe('`npm run check`', () => {
  async function runCheck(testExit: number | null, lintExit = 0) {
    const lines: string[] = [];
    const ran: string[][] = [];
    const code = await check({
      root: '/repo',
      deps: {
        collectChanges: changed('package.json', 'src/a.ts'),
        exists: () => true,
        node: (args) => {
          ran.push(args);
          if (args[0] === TEST_ARGS[0]) return testExit;
          if (args[0] === ESLINT_ARGS[0]) return lintExit;
          return 0;
        },
        out: (line) => lines.push(line),
      },
    });
    return { code, ran, text: lines.join('\n') };
  }

  it('asks the runner for --never-full', () => {
    expect(TEST_ARGS).toEqual(['scripts/smart-test/main.mjs', '--never-full']);
  });

  it('skipped tests: Prettier and ESLint still run, and the summary says Jest did not', async () => {
    const { code, ran, text } = await runCheck(SKIPPED_FULL_EXIT);
    expect(ran).toEqual([
      [...PRETTIER_ARGS, 'package.json', 'src/a.ts'],
      [...ESLINT_ARGS, 'src/a.ts'],
      TEST_ARGS,
    ]);
    expect(code).toBe(0);
    expect(text).toContain('Jest:                     SKIPPED — NOT RUN.');
    expect(text).toContain('CI');
  });

  it('skipped tests do not hide a lint failure', async () => {
    const { code, text } = await runCheck(SKIPPED_FULL_EXIT, 1);
    expect(code).toBe(1);
    expect(text).toContain('ESLint (changed files):   FAILED');
  });

  it('Smart tests that ran: their result is the result', async () => {
    expect((await runCheck(0)).code).toBe(0);
    const failed = await runCheck(1);
    expect(failed.code).toBe(1);
    expect(failed.text).toContain('Jest (Smart mode):        FAILED');
  });
});

describe('`npm run test:full` keeps its contract', () => {
  it('is the plain Jest command of every node and web test, outside the selector', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const scripts = (
      JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { scripts: Record<string, string> }
    ).scripts;
    expect(scripts['test:full']).toBe(`node ${FULL_JEST_ARGS.join(' ')}`);
    expect(scripts['check']).toBe('node scripts/check.mjs');
  });
});
