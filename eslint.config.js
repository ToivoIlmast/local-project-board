// @ts-check
import js from '@eslint/js';
import eslintReact from '@eslint-react/eslint-plugin';
import boundaries from 'eslint-plugin-boundaries';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Architectural boundaries (docs/PROPOSAL.ru.md §20).
 * Patterns match the end of a path, so they apply equally to `src/` and to the
 * deliberate violations in `test/lint/fixtures/src/`, which test/lint verifies.
 */
const elements = [
  { type: 'core', pattern: 'src/core', stopMatching: true },
  { type: 'contract', pattern: 'src/contract', stopMatching: true },
  { type: 'server-http', pattern: 'src/server/http', stopMatching: true },
  { type: 'server-cli', pattern: 'src/server/cli', stopMatching: true },
  { type: 'server-adapter', pattern: 'src/server/*', capture: ['adapter'], stopMatching: true },
  { type: 'web-app', pattern: 'src/web/app', stopMatching: true },
  { type: 'web-pages', pattern: 'src/web/pages', stopMatching: true },
  { type: 'web-api', pattern: 'src/web/api', stopMatching: true },
  { type: 'web-shared', pattern: 'src/web/shared', stopMatching: true },
  { type: 'web-feature', pattern: 'src/web/features/*', capture: ['feature'], stopMatching: true },
];

/** @param {string[]} types */
const to = (types) => ({ to: { element: { types: { anyOf: types } } } });

const dependencyPolicies = [
  { from: { element: { type: 'core' } }, allow: to(['core']) },
  { from: { element: { type: 'contract' } }, allow: to(['core', 'contract']) },
  { from: { element: { type: 'server-adapter' } }, allow: to(['core', 'server-adapter']) },
  { from: { element: { type: 'server-http' } }, allow: to(['core', 'contract', 'server-http']) },
  {
    from: { element: { type: 'server-cli' } },
    allow: to(['core', 'contract', 'server-http', 'server-adapter', 'server-cli']),
  },
  {
    from: { element: { type: 'web-app' } },
    allow: to(['web-app', 'web-pages', 'web-feature', 'web-shared', 'web-api']),
  },
  {
    from: { element: { type: 'web-pages' } },
    allow: to(['web-pages', 'web-feature', 'web-shared']),
  },
  { from: { element: { type: 'web-api' } }, allow: to(['web-api', 'contract', 'web-shared']) },
  { from: { element: { type: 'web-shared' } }, allow: to(['web-shared']) },
  // A feature may use the API client, shared primitives and contract types…
  { from: { element: { type: 'web-feature' } }, allow: to(['web-api', 'web-shared', 'contract']) },
  // …anything inside itself…
  {
    from: { element: { type: 'web-feature' } },
    allow: { dependency: { relationship: { to: 'internal' } } },
  },
  // …and another feature only through its public API (index.ts, or a single-file feature).
  {
    from: { element: { type: 'web-feature' } },
    allow: {
      to: {
        element: { type: 'web-feature', fileInternalPath: ['index.ts', 'index.tsx', null] },
      },
    },
  },
];

const nodeBuiltins = {
  group: ['node:*', 'fs', 'path', 'os', 'child_process', 'http', 'https', 'net', 'url'],
  message: 'core and contract are pure TypeScript: no Node APIs (they must also run in a browser).',
};
const noFrameworks = {
  group: ['express', 'express/*', 'react', 'react/*', 'react-dom', 'react-dom/*'],
  message: 'core and contract must not depend on HTTP or UI frameworks.',
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'test/lint/fixtures/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },

  // Type-aware correctness rules where async/IO bugs live.
  {
    files: ['src/core/**/*.ts', 'src/contract/**/*.ts', 'src/server/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },

  // React (web only).
  {
    files: ['**/src/web/**/*.{ts,tsx}'],
    ...eslintReact.configs['recommended-typescript'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['**/src/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  // Architecture: layer dependencies.
  {
    files: ['**/src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': elements,
      'import/resolver': { typescript: { alwaysTryTypes: true } },
    },
    rules: {
      'boundaries/dependencies': ['error', { default: 'disallow', policies: dependencyPolicies }],
    },
  },

  // Architecture: forbidden external modules and globals.
  {
    files: ['**/src/core/**/*.ts', '**/src/contract/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [nodeBuiltins, noFrameworks] }],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'core must not make network calls (local-first).' },
        { name: 'process', message: 'core must not depend on the Node process.' },
      ],
    },
  },
  {
    files: ['**/src/server/**/*.ts'],
    ignores: ['**/src/server/http/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['express', 'express/*'], message: 'Express lives only in src/server/http.' },
          ],
        },
      ],
    },
  },
  {
    files: ['**/src/web/**/*.{ts,tsx}'],
    ignores: ['**/src/web/api/**', '**/src/web/shared/lib/http*'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/*/*'],
              message: 'Import a feature through its public API (index.ts).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Talk to the server only through web/api (BoardClient).' },
      ],
    },
  },

  prettier,
);
