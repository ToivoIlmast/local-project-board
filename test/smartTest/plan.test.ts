import { planTests, referenceToken } from '../../scripts/smart-test/plan.mjs';
import { MAX_CHANGED_FILES } from '../../scripts/smart-test/rules.mjs';
import { extract } from '../../scripts/smart-test/extractor.mjs';

/**
 * The planner on a small made-up repository: a dependency graph (what Jest would answer), the
 * text of a few files (what `git grep` would find) and twenty test files, so one module's tests
 * stay well below the share that turns a run into Full mode.
 */
type Status = 'A' | 'M' | 'D';
type Change = { status: Status; path: string };

const filler = Array.from({ length: 14 }, (_, i) => `test/other/t${i}.test.ts`);
const TESTS = [
  { path: 'test/core/rank.test.ts', project: 'node' },
  { path: 'test/core/model.test.ts', project: 'node' },
  { path: 'test/docs/readme.test.ts', project: 'node' },
  { path: 'test/api/scan.test.ts', project: 'node' },
  { path: 'test/web/board.test.tsx', project: 'web' },
  { path: 'test/web/settings.test.tsx', project: 'web' },
  ...filler.map((path) => ({ path, project: 'node' })),
];

/** Which tests depend on a file, as Jest's graph would say. */
const GRAPH: Record<string, string[]> = {
  'src/core/rules/rank.ts': ['test/core/rank.test.ts'],
  'src/core/model/task.ts': ['test/core/model.test.ts', 'test/web/board.test.tsx'],
  'src/web/features/settings/draft.ts': ['test/web/settings.test.tsx'],
  'src/core/model/index.ts': ['test/core/model.test.ts', 'test/core/rank.test.ts'],
  'test/support/translations.ts': ['test/docs/readme.test.ts'],
  'src/core/shared.ts': TESTS.map((t) => t.path),
};

/** The text of files that mention other files by name. */
const TEXT: Record<string, string> = {
  'src/core/model/index.ts': "export * from './old.js';",
  'test/support/translations.ts': "readFileSync('README.md')",
  'test/docs/readme.test.ts': "import './../support/translations.js'",
  'test/core/rank.test.ts': "import { rank } from '../../src/core/rules/rank.js'",
};

function input(changes: Change[], scanners: string[] = ['test/api/scan.test.ts']) {
  return {
    changes,
    tests: TESTS,
    related: async (paths: string[]) => [...new Set(paths.flatMap((p) => GRAPH[p] ?? []))].sort(),
    projectWide: new Map([['test/web/support/setup.ts', 'web']]),
    scanners,
    references: async (token: string) =>
      Object.entries(TEXT)
        .filter(([, text]) => text.includes(token))
        .map(([file]) => file),
  };
}

const M = (path: string): Change => ({ status: 'M', path });
const A = (path: string): Change => ({ status: 'A', path });
const D = (path: string): Change => ({ status: 'D', path });

describe('Smart mode selects the tests a change can reach', () => {
  it('one changed file: the tests that depend on it and the src/ tree checks, nothing else', async () => {
    const plan = await planTests(input([M('src/core/rules/rank.ts')]));
    expect(plan.mode).toBe('smart');
    expect([...plan.selected.keys()]).toEqual(['test/api/scan.test.ts', 'test/core/rank.test.ts']);
    expect(plan.selected.get('test/core/rank.test.ts')).toEqual([
      'depends on src/core/rules/rank.ts',
    ]);
    expect(plan.selected.get('test/api/scan.test.ts')).toEqual(['scans the src/ tree']);
    expect(plan.skipped).toHaveLength(TESTS.length - 2);
    expect(plan.skipped).not.toContain('test/core/rank.test.ts');
  });

  it('several files: the union, with every reason a test was chosen for', async () => {
    const plan = await planTests(
      input([M('src/core/model/task.ts'), M('src/web/features/settings/draft.ts')]),
    );
    expect([...plan.selected.keys()]).toEqual([
      'test/api/scan.test.ts',
      'test/core/model.test.ts',
      'test/web/board.test.tsx',
      'test/web/settings.test.tsx',
    ]);
    expect(plan.files.map((f) => f.tests.length)).toEqual([3, 2]);
  });

  it('a new test file runs itself; a changed one too', async () => {
    const plan = await planTests(input([A('test/other/t3.test.ts'), M('test/other/t4.test.ts')]));
    expect(plan.selected.get('test/other/t3.test.ts')).toEqual(['new test file']);
    expect(plan.selected.get('test/other/t4.test.ts')).toEqual(['changed test file']);
  });

  it('a new source file nothing uses yet is reported as reached by no test', async () => {
    const plan = await planTests(input([A('src/core/rules/fresh.ts')]));
    const [file] = plan.files;
    expect(file?.uncovered).toBe(true);
    expect(file?.detail).toContain('NO TEST DEPENDS ON THIS FILE');
    // The tree checks still run: a new file under src/ is exactly what they look at.
    expect([...plan.selected.keys()]).toEqual(['test/api/scan.test.ts']);
  });

  it('a deleted file: the files that still name it, and their tests, run (INVARIANT)', async () => {
    // The graph no longer has the file, so Jest alone would find nothing to run.
    const plan = await planTests(input([D('src/core/model/old.ts')]));
    expect([...plan.selected.keys()]).toEqual([
      'test/api/scan.test.ts',
      'test/core/model.test.ts',
      'test/core/rank.test.ts',
    ]);
    expect(plan.selected.get('test/core/model.test.ts')?.[0]).toBe(
      'depends on src/core/model/index.ts, which names src/core/model/old.ts',
    );
    expect(plan.files[0]?.uncovered).toBe(false);
  });

  it('a deleted file that nothing names any more selects only the tree checks', async () => {
    const plan = await planTests(input([D('src/core/rules/unused.ts')]));
    expect(plan.files[0]?.detail).toContain('nothing names it any more');
    expect([...plan.selected.keys()]).toEqual(['test/api/scan.test.ts']);
  });

  it('a rename is followed on both sides: who named the old path, who uses the new one', async () => {
    const plan = await planTests(input([D('src/core/model/old.ts'), A('src/core/rules/rank.ts')]));
    expect([...plan.selected.keys()]).toEqual([
      'test/api/scan.test.ts',
      'test/core/model.test.ts',
      'test/core/rank.test.ts',
    ]);
  });

  it('a deleted test file has nothing left to run and widens nothing', async () => {
    const plan = await planTests(input([D('test/core/gone.test.ts')]));
    expect(plan.mode).toBe('none');
    expect(plan.files[0]?.detail).toBe('test file deleted: nothing left to run');
  });

  it('a shared module that most tests depend on turns the run into Full mode', async () => {
    const plan = await planTests(input([M('src/core/shared.ts')]));
    expect(plan.mode).toBe('full');
    expect(plan.fullBecause[0]).toMatch(/^20 of 20 test files selected/);
    expect(plan.selected.size).toBe(TESTS.length);
    expect(plan.skipped).toEqual([]);
  });

  it('a file every test of a project loads selects that whole project', async () => {
    const plan = await planTests(input([M('test/web/support/setup.ts')]));
    expect(plan.mode).toBe('smart');
    expect([...plan.selected.keys()]).toEqual([
      'test/web/board.test.tsx',
      'test/web/settings.test.tsx',
    ]);
    expect(plan.files[0]?.effect).toBe('project');
  });

  it('a non-code file is followed through the files that name it', async () => {
    const plan = await planTests(input([M('README.md')]));
    expect([...plan.selected.keys()]).toEqual(['test/docs/readme.test.ts']);
    expect(plan.selected.get('test/docs/readme.test.ts')?.[0]).toBe(
      'depends on test/support/translations.ts, which names README.md',
    );
  });

  it('a document no file names runs no test, and says so', async () => {
    const plan = await planTests(input([M('docs/architecture.md')]));
    expect(plan.mode).toBe('none');
    expect(plan.selected.size).toBe(0);
    expect(plan.skipped).toHaveLength(TESTS.length);
    expect(plan.files[0]?.detail).toBe('no Jest test depends on it');
  });

  it('no changes at all: no test runs and nothing is called checked', async () => {
    const plan = await planTests(input([]));
    expect(plan.mode).toBe('none');
    expect(plan.skipped).toHaveLength(TESTS.length);
  });

  it('a file of another test runner names the command that checks it', async () => {
    const plan = await planTests(input([M('test/e2e/board.spec.ts'), M('bin/board.js')]));
    expect(plan.mode).toBe('none');
    expect(plan.files.map((f) => f.outside)).toEqual([
      'Playwright: `npm run test:e2e` (CI runs it)',
      'build and packaging: `npm run test:pack` and `npm run test:e2e` (CI runs them)',
    ]);
  });
});

describe('Smart mode widens to Full mode when it cannot see how far a change reaches', () => {
  it.each([
    ['package.json', 'npm scripts or dependencies'],
    ['package-lock.json', 'locked dependency versions'],
    ['jest.config.js', 'Jest configuration'],
    ['tsconfig.test-web.json', 'TypeScript configuration'],
    ['eslint.config.js', 'tool configuration'],
    ['.nvmrc', 'toolchain'],
    ['scripts/smart-test/plan.mjs', 'the test selector itself'],
    ['src/web/vite-env.d.ts', 'global type declarations'],
    ['some.config.mjs', 'no rule knows'],
    ['settings.json', 'no rule knows'],
  ])('%s', async (path, why) => {
    for (const status of ['A', 'M', 'D'] as const) {
      const plan = await planTests(input([{ status, path }, M('src/core/rules/rank.ts')]));
      expect(plan.mode).toBe('full');
      expect(plan.fullBecause.join('\n')).toContain(why);
      expect(plan.skipped).toEqual([]);
      expect(plan.selected.size).toBe(TESTS.length);
    }
  });

  it('a mass change', async () => {
    const many = Array.from({ length: MAX_CHANGED_FILES + 1 }, (_, i) => M(`docs/n${i}.md`));
    const plan = await planTests(input(many));
    expect(plan.mode).toBe('full');
    expect(plan.fullBecause[0]).toContain('a mass change');
  });

  it('never selects fewer tests than the dependency graph does (INVARIANT)', async () => {
    for (const [file, tests] of Object.entries(GRAPH)) {
      const plan = await planTests(input([M(file)]));
      for (const test of tests) expect(plan.selected.has(test)).toBe(true);
    }
  });
});

describe('referenceToken: how another file would name this one', () => {
  it.each([
    ['src/core/rules/rank.ts', '/rank'],
    ['src/web/ui/Board.tsx', '/Board'],
    ['src/core/model/index.ts', '/model'],
    ['src/web/vite-env.d.ts', '/vite-env'],
    ['test/support/styleStub.cjs', '/styleStub'],
    ['README.md', 'README.md'],
    ['docs/api.md', 'api.md'],
  ])('%s → %s', (path, token) => {
    expect(referenceToken(path)).toBe(token);
  });
});

describe('the dependency extractor of the selector', () => {
  it('keeps the imports Jest drops: `import type` and `export type … from`', () => {
    const code = [
      "import type { A } from './a.js';",
      "import { type B, c } from './b.js';",
      "export type { D } from '../d.js';",
      "export * from './e.js';",
      "const f = await import('./f.js');",
    ].join('\n');
    // Jest's own extractor, reduced to what it does with these lines.
    const jestDefault = (text: string) =>
      [
        ...text.matchAll(
          /\b(?:import|export)\s+(?!type\s)(?:[^'"]+\s+from\s+)?'([^']+)'|import\('([^']+)'\)/g,
        ),
      ].map((m) => m[1] ?? m[2] ?? '');
    expect([...extract(code, 'x.ts', jestDefault)].sort()).toEqual([
      '../d.js',
      './a.js',
      './b.js',
      './e.js',
      './f.js',
    ]);
  });
});
