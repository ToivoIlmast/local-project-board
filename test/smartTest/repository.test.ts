import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesToCheck } from '../../scripts/check-changed.mjs';
import { referencesIn } from '../../scripts/smart-test/changes.mjs';
import { loadJest } from '../../scripts/smart-test/jest.mjs';
import { planTests } from '../../scripts/smart-test/plan.mjs';
import { FULL_JEST_ARGS } from '../../scripts/smart-test/rules.mjs';

/**
 * Smart testing as this repository wires it: the npm scripts, the CI workflows, the
 * instructions agents read, and the selector on this repository's real Jest graph.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

describe('the entry points', () => {
  it('`npm test` is the Smart runner; `npm run test:full` is the plain Jest command', () => {
    expect(scripts['test']).toBe('node scripts/smart-test/main.mjs');
    expect(scripts['test:full']).toBe(`node ${FULL_JEST_ARGS.join(' ')}`);
    expect(scripts['test:full']).toBe(
      'node --experimental-vm-modules node_modules/jest/bin/jest.js --selectProjects node web',
    );
  });

  it('there is one selector: no other script picks tests from changes', () => {
    for (const [name, command] of Object.entries(scripts)) {
      if (name === 'test') continue;
      expect(command).not.toMatch(/smart-test|--onlyChanged|--changedSince|--findRelatedTests/);
    }
  });

  it('the selector is type-checked with the rest', () => {
    expect(scripts['typecheck']).toContain('tsc -p tsconfig.scripts.json');
  });
});

describe('GitHub Actions always run every test (INVARIANT)', () => {
  const workflows = readdirSync(join(ROOT, '.github/workflows'))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({ name, text: read(`.github/workflows/${name}`) }));
  const runLines = (text: string): string[] =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^-?\s*run:/.test(line))
      .map((line) => line.replace(/^-?\s*run:\s*/, ''));

  it.each(workflows.map((w) => [w.name, w.text]))(
    '%s runs Jest only as the full command',
    (_name, text) => {
      for (const line of runLines(text)) {
        expect(line).not.toMatch(/^npm (run )?test(\s|$)/);
        expect(line).not.toMatch(/smart-test|onlyChanged|changedSince|findRelatedTests|git diff/);
      }
    },
  );

  it('ci.yml keeps every check it had, with the full Jest run among them', () => {
    const ci = runLines(read('.github/workflows/ci.yml'));
    for (const command of [
      'npm ci',
      'npm run format:check',
      'npm run lint',
      'npm run typecheck',
      'npm run check:cycles',
      'npm run test:full',
      'npm run test:pack',
      'npm run test:e2e',
    ]) {
      expect(ci).toContain(command);
    }
  });

  it('the runner itself runs everything under CI, without reading git', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/smart-test/main.mjs', '--plan', '--json', '--changed', 'docs/notes.md'],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: 'true' } },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      kind: 'forced-full',
      why: 'CI always runs every test',
    });
  });
});

describe('the instructions every agent and Board Runner task reads', () => {
  it('CLAUDE.md names both commands', () => {
    const text = read('CLAUDE.md');
    expect(text).toContain('`npm test`');
    expect(text).toContain('`npm run test:full`');
  });

  it('the local default is `npm run check`, with no whole-project check in it', () => {
    const block = /## Checks[\s\S]*?```sh\n([\s\S]*?)```/.exec(read('CLAUDE.md'))?.[1];
    expect(block?.trim()).toBe('npm run check');
    expect(scripts['check']).toBe('node scripts/check.mjs');
  });
});

describe('`npm run check`: changed files only', () => {
  it('formats every present changed file and lints only code', () => {
    expect(
      filesToCheck([
        { status: 'M', path: 'src/core/a.ts' },
        { status: 'A', path: 'src/web/b.tsx' },
        { status: 'M', path: 'scripts/c.mjs' },
        { status: 'M', path: 'README.md' },
        { status: 'D', path: 'src/core/gone.ts' },
      ]),
    ).toEqual({
      format: ['src/core/a.ts', 'src/web/b.tsx', 'scripts/c.mjs', 'README.md'],
      lint: ['src/core/a.ts', 'src/web/b.tsx', 'scripts/c.mjs'],
    });
  });

  it('runs no whole-project command', () => {
    const text = read('scripts/check-changed.mjs');
    for (const heavy of [
      /eslint\.js', '\.'/,
      /tsc\b/,
      /check:cycles'/,
      /test:full'/,
      /playwright/,
    ]) {
      expect(text).not.toMatch(heavy);
    }
  });
});

describe('Smart mode on this repository’s real Jest graph', () => {
  let jest: Awaited<ReturnType<typeof loadJest>>;
  beforeAll(async () => {
    jest = await loadJest(ROOT);
  }, 60_000);

  const plan = (...paths: string[]) =>
    planTests({
      changes: paths.map((path) => ({ status: 'M' as const, path })),
      tests: jest.tests,
      related: jest.related,
      projectWide: jest.projectWide,
      scanners: jest.scanners,
      references: referencesIn(ROOT),
    });

  it('knows the tests of both projects', () => {
    const projects = new Set(jest.tests.map((t) => t.project));
    expect(projects).toEqual(new Set(['node', 'web']));
    expect(jest.tests.some((t) => t.path.startsWith('test/pack/'))).toBe(false);
    expect(jest.tests.some((t) => t.path.startsWith('test/e2e/'))).toBe(false);
  });

  it('resolves the `@/` alias of the web project', async () => {
    const result = await plan('src/web/features/settings/model/draft.ts');
    expect(result.selected.get('test/web/settings/draft.test.ts')).toContain(
      'depends on src/web/features/settings/model/draft.ts',
    );
  });

  it('follows imports of types only', async () => {
    const result = await plan('src/core/ports.ts');
    expect(result.selected.get('test/storage/markdown.test.ts')).toContain(
      'depends on src/core/ports.ts',
    );
  });

  it('treats the web setup file as reaching every web test', () => {
    expect(jest.projectWide.get('test/web/support/setup.ts')).toBe('web');
    expect(jest.projectWide.get('test/web/support/styleStub.cjs')).toBe('web');
  });

  it('finds the tests that scan the src/ tree instead of importing it', () => {
    expect(jest.scanners).toEqual(
      expect.arrayContaining([
        'test/api/run.test.ts',
        'test/api/security.test.ts',
        'test/config/load.test.ts',
        'test/contract/claudeCode.test.ts',
        'test/lint/boundaries.test.ts',
        'test/web/ui/cardSendToAi.test.tsx',
      ]),
    );
  });

  it('follows documents that tests read: README.md and docs/api.md', async () => {
    const result = await plan('README.md', 'docs/api.md');
    expect(result.selected.has('test/docs/readmeTranslations.test.ts')).toBe(true);
    expect(result.selected.has('test/contract/apiDoc.test.ts')).toBe(true);
  });
});
