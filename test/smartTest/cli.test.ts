import { decide, isCi, jestArgv, main, parseArgs } from '../../scripts/smart-test/cli.mjs';
import { FULL_JEST_ARGS } from '../../scripts/smart-test/rules.mjs';

/**
 * The runner's decisions with git and Jest replaced: which mode a run is in, and the exact Jest
 * command line it leads to. Every way of losing track of the changes must end in Full mode.
 */
const TESTS = Array.from({ length: 10 }, (_, i) => ({
  path: `test/t${i}.test.ts`,
  project: 'node',
}));

type Deps = NonNullable<Parameters<typeof decide>[0]['deps']>;

function deps(overrides: Partial<Deps> = {}): Deps & { gitCalls: number } {
  const state = { gitCalls: 0 };
  const base: Deps = {
    collectChanges: async () => {
      state.gitCalls++;
      return {
        ok: true,
        changes: [{ status: 'M', path: 'src/a.ts' }],
        base: 'origin/main',
        mergeBase: '0123456789abcdef',
        commits: 2,
        notes: [],
      };
    },
    loadJest: async () => ({
      tests: TESTS,
      related: async (paths: string[]) => (paths.includes('src/a.ts') ? ['test/t1.test.ts'] : []),
      projectWide: new Map(),
      scanners: [],
    }),
    referencesIn: () => async () => [],
    exists: () => true,
  };
  return Object.assign(state, base, overrides);
}

const run = (argv: string[], env: NodeJS.ProcessEnv = {}, d = deps()) =>
  decide({ options: parseArgs(argv), env, root: '/repo', deps: d });

describe('which mode a run is in', () => {
  it('Smart mode by default: the tests of the changed files, by path', async () => {
    const { decision } = await run([]);
    expect(decision.kind).toBe('plan');
    expect(jestArgv(decision, parseArgs([]))).toEqual([
      ...FULL_JEST_ARGS,
      '--runTestsByPath',
      'test/t1.test.ts',
    ]);
  });

  it.each([[{ CI: 'true' }], [{ CI: '1' }], [{ GITHUB_ACTIONS: 'true' }]])(
    'CI forces Full mode, without reading git, whatever else is asked (%o)',
    async (env) => {
      const d = deps();
      const argv = ['--changed', 'src/a.ts', 'test/t1.test.ts', '-t', 'only this', '--silent'];
      const { decision, warnings } = await run(argv, env, d);
      expect(decision).toEqual({ kind: 'forced-full', why: 'CI always runs every test' });
      expect(d.gitCalls).toBe(0);
      expect(warnings[0]).toMatch(/ignoring the test selection test\/t1.test.ts -t only this/);
      expect(jestArgv(decision, parseArgs(argv))).toEqual([...FULL_JEST_ARGS, '--silent']);
    },
  );

  it.each([[{ CI: 'false' }], [{ CI: '0' }], [{ CI: '' }]])(
    'CI turned off explicitly is not CI (%o)',
    (env) => {
      expect(isCi(env)).toBe(false);
    },
  );

  it('--full runs everything and never asks git', async () => {
    const d = deps();
    const { decision } = await run(['--full'], {}, d);
    expect(decision).toEqual({ kind: 'forced-full', why: 'requested with --full' });
    expect(d.gitCalls).toBe(0);
    expect(jestArgv(decision, parseArgs(['--full']))).toEqual(FULL_JEST_ARGS);
  });

  it('a path, a pattern or -t hands the choice to the person: MANUAL', async () => {
    for (const argv of [['test/core'], ['-t', 'rank'], ['--testPathPatterns=web'], ['--watch']]) {
      const { decision } = await run(argv);
      expect(decision).toEqual({ kind: 'manual', args: argv });
      expect(jestArgv(decision, parseArgs(argv))).toEqual([...FULL_JEST_ARGS, ...argv]);
    }
  });

  it('other Jest options are passed on and keep Smart mode', async () => {
    const argv = ['--silent', '--maxWorkers', '2', '--coverage'];
    const options = parseArgs(argv);
    expect(options).toMatchObject({ selection: [], jestFlags: argv });
    const { decision } = await run(argv);
    expect(jestArgv(decision, options)).toEqual([
      ...FULL_JEST_ARGS,
      ...argv,
      '--runTestsByPath',
      'test/t1.test.ts',
    ]);
  });

  it('git that cannot answer → Full mode, with the reason', async () => {
    const d = deps({
      collectChanges: async () => ({ ok: false, reason: 'git is in the middle of a merge' }),
    });
    const { decision } = await run([], {}, d);
    expect(decision).toEqual({
      kind: 'forced-full',
      why: 'Smart mode cannot tell what changed: git is in the middle of a merge',
    });
  });

  it('a Jest graph that cannot be built → Full mode, with the reason', async () => {
    const d = deps({
      loadJest: async () => {
        throw new Error('haste map exploded');
      },
    });
    const { decision } = await run([], {}, d);
    expect(decision).toEqual({
      kind: 'forced-full',
      why: 'Smart mode could not relate changes to tests (haste map exploded)',
    });
  });

  it('--changed replaces git: an existing path is changed, a missing one deleted', async () => {
    const d = deps({ exists: (path) => !path.includes('gone') });
    const { decision } = await run(['--changed', 'src/a.ts', '--changed=src/gone.ts'], {}, d);
    expect(d.gitCalls).toBe(0);
    if (decision.kind !== 'plan') throw new Error(decision.kind);
    expect(decision.plan.files.map((f) => f.change)).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'D', path: 'src/gone.ts' },
    ]);
  });
});

describe('what the person reads', () => {
  async function output(argv: string[], d = deps(), exitCode: number | null = 0) {
    const lines: string[] = [];
    const ran: string[][] = [];
    const code = await main({
      argv,
      env: {},
      root: '/repo',
      out: (line) => lines.push(line),
      run: (args) => {
        ran.push(args);
        return exitCode;
      },
      deps: d,
    });
    return { code, text: lines.join('\n'), ran };
  }

  it('a Smart run says, before and after Jest, that it is not a full check', async () => {
    const { text, ran, code } = await output([]);
    expect(code).toBe(0);
    expect(ran).toHaveLength(1);
    expect(text).toContain('Tests: SMART mode — only the tests your changes can reach.');
    expect(text).toContain('changed src/a.ts — 1 test(s) depend on it');
    expect(text).toContain('Selected: 1 of 10 test files (node 1)');
    expect(text).toContain('test/t1.test.ts — depends on src/a.ts');
    expect(text).toContain('Not run: 9 test files.');
    expect(text).toContain('SMART mode passed: 1 of 10 test files ran, 9 did not.');
    expect(text.match(/NOT a full check/g)).toHaveLength(2);
    expect(text).toContain('2 commits since `origin/main` (merge base 01234567)');
  });

  it('--list-skipped names every test that does not run', async () => {
    const { text } = await output(['--list-skipped']);
    for (const i of [0, 2, 3, 4, 5, 6, 7, 8, 9]) expect(text).toContain(`  test/t${i}.test.ts`);
  });

  it('Jest failing is the exit code of the run', async () => {
    const { code, text } = await output([], deps(), 1);
    expect(code).toBe(1);
    expect(text).toContain('SMART mode FAILED');
  });

  it('nothing to run: Jest is not started, and the run is not called a check', async () => {
    const d = deps({
      collectChanges: async () => ({
        ok: true,
        changes: [{ status: 'M', path: 'docs/notes.md' }],
        base: 'origin/main',
        mergeBase: 'abc',
        commits: 0,
        notes: [],
      }),
    });
    const { ran, text, code } = await output([], d);
    expect(code).toBe(0);
    expect(ran).toEqual([]);
    expect(text).toContain('NO TEST RUNS');
    expect(text).toContain('NOT a full check');
  });

  it('--plan prints the plan and runs nothing; --json makes it data', async () => {
    const { ran, text } = await output(['--plan', '--json']);
    expect(ran).toEqual([]);
    const plan = JSON.parse(text) as { mode: string; selected: Record<string, string[]> };
    expect(plan.mode).toBe('smart');
    expect(plan.selected).toEqual({ 'test/t1.test.ts': ['depends on src/a.ts'] });
  });

  it('a Full run says why it is one', async () => {
    const d = deps({ collectChanges: async () => ({ ok: false, reason: 'not a git checkout' }) });
    const { text } = await output([], d);
    expect(text).toContain(
      'Tests: FULL mode — Smart mode cannot tell what changed: not a git checkout.',
    );
    expect(text).toContain('FULL mode passed: every node and web test file ran.');
  });

  it('a bad option is an error, not a run', async () => {
    const { code, ran, text } = await output(['--base']);
    expect(code).toBe(2);
    expect(ran).toEqual([]);
    expect(text).toContain('--base needs a value');
  });
});
