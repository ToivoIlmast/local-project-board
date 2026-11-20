// @ts-check
/**
 * Jest's own view of the repository: which files are tests of which project, and which tests
 * depend on a file. It is the dependency graph `jest --findRelatedTests` uses (with this
 * project's `moduleNameMapper`, so `./x.js` → `x.ts` and `@/…` resolve as in a real run), built
 * once and asked once per changed file, so the report can say why each test was chosen.
 *
 * Jest's internals are loaded from where the installed `jest` loads them, so their versions
 * always match the Jest that runs the tests.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JEST_PROJECTS, TREE_SCANNER_PATTERNS } from './rules.mjs';

/**
 * @typedef {{ path: string, project: string }} TestFile  `path` is repository-relative, `/`-separated.
 * @typedef {object} JestView
 * @property {TestFile[]} tests                  Every test file of the selected projects.
 * @property {(paths: string[]) => Promise<string[]>} related  Tests that depend on any of the files.
 * @property {Map<string, string>} projectWide   File → project whose every test it reaches (setup files).
 * @property {string[]} scanners                 Tests that read the `src/` tree instead of importing it.
 */

/**
 * @param {string} root
 * @returns {Promise<JestView>}
 */
export async function loadJest(root) {
  const realRoot = realpathSync.native(root);
  const requireHere = createRequire(join(realRoot, 'package.json'));
  const requireCore = createRequire(requireHere.resolve('@jest/core'));
  const { readConfigs } = requireCore('jest-config');
  const Runtime = requireCore('jest-runtime').default;
  const { SearchSource } = requireCore('@jest/core');

  const { configs } = await readConfigs({ $0: 'jest', _: [], selectProjects: [...JEST_PROJECTS] }, [
    realRoot,
  ]);
  /** @param {string} file */
  const rel = (file) => relative(realRoot, file).split(sep).join('/');
  /** @param {string} path */
  const abs = (path) => (isAbsolute(path) ? path : join(realRoot, ...path.split('/')));

  /** @type {{ name: string, search: any, context: any }[]} */
  const projects = [];
  for (const config of configs) {
    const name = config.displayName?.name;
    if (!JEST_PROJECTS.includes(name)) continue;
    // Jest's graph without type-only imports would miss tests that ts-jest type-checks against them.
    const graphConfig = {
      ...config,
      dependencyExtractor: fileURLToPath(new URL('./extractor.mjs', import.meta.url)),
    };
    const context = await Runtime.createContext(graphConfig, {
      maxWorkers: 2,
      watch: false,
      watchman: false,
    });
    projects.push({ name, search: new SearchSource(context), context });
  }
  const missing = JEST_PROJECTS.filter((name) => !projects.some((p) => p.name === name));
  if (missing.length > 0) throw new Error(`Jest projects not found: ${missing.join(', ')}`);

  /** @type {TestFile[]} */
  const tests = [];
  for (const { name, search, context } of projects) {
    for (const file of context.hasteFS.getAllFiles()) {
      if (search.isTestFilePath(file)) tests.push({ path: rel(file), project: name });
    }
  }
  tests.sort((a, b) => a.path.localeCompare(b.path));

  /** @type {Map<string, string>} */
  const projectWide = new Map();
  for (const { name, context } of projects) {
    for (const file of setupClosure(context, realRoot)) projectWide.set(rel(file), name);
  }

  const scanners = tests
    .filter(({ path }) => {
      const text = readFileSync(abs(path), 'utf8');
      return TREE_SCANNER_PATTERNS.some((pattern) => pattern.test(text));
    })
    .map(({ path }) => path);

  return {
    tests,
    projectWide,
    scanners,
    related: async (paths) => {
      /** @type {Set<string>} */
      const found = new Set();
      for (const { search } of projects) {
        const result = await search.findRelatedTests(new Set(paths.map(abs)), false);
        for (const test of result.tests) found.add(rel(test.path));
      }
      return [...found].sort();
    },
  };
}

/**
 * Files every test of a project loads before it starts: setup files, the modules mapped in
 * `moduleNameMapper` and what they import from the repository.
 * @param {any} context
 * @param {string} root
 * @returns {Set<string>}
 */
function setupClosure(context, root) {
  const config = context.config;
  /** @type {string[]} */
  const start = [
    ...(config.setupFiles ?? []),
    ...(config.setupFilesAfterEnv ?? []),
    ...(config.globalSetup ? [config.globalSetup] : []),
    ...(config.globalTeardown ? [config.globalTeardown] : []),
    ...(config.moduleNameMapper ?? [])
      .map((/** @type {[string, string | string[]]} */ [, target]) =>
        Array.isArray(target) ? target : [target],
      )
      .flat()
      .filter((/** @type {string} */ target) => !target.includes('$')),
    ...(typeof config.testEnvironment === 'string' && isAbsolute(config.testEnvironment)
      ? [config.testEnvironment]
      : []),
  ];
  /** @param {string} file */
  const inRepo = (file) =>
    file.startsWith(root + sep) && !file.includes(`${sep}node_modules${sep}`);
  /** @type {Set<string>} */
  const seen = new Set();
  const queue = start.filter(inRepo);
  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.pop());
    if (seen.has(file)) continue;
    seen.add(file);
    /** @type {string[]} */
    const dependencies = context.hasteFS.getDependencies(file) ?? [];
    for (const dependency of dependencies) {
      try {
        const resolved = context.resolver.resolveModule(file, dependency);
        if (inRepo(resolved)) queue.push(resolved);
      } catch {
        // A package or a path Jest cannot resolve: not a file of this repository.
      }
    }
  }
  return seen;
}
