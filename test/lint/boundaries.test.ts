/**
 * Architecture rules (docs/PROPOSAL.ru.md §20) are only real if ESLint enforces them.
 * Each fixture under test/lint/fixtures is a deliberate violation or a deliberately
 * allowed import. If the ESLint config drifts, one of these cases fails.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = (p: string) => path.join(root, 'test/lint/fixtures/src', p);
const eslint = new ESLint({ cwd: root, ignore: false });

/** Loading the whole ESLint config is slow, and slower still while the other suites run. */
const LINT_TIMEOUT_MS = 60_000;

async function ruleIds(file: string): Promise<string[]> {
  const [result] = await eslint.lintFiles([fixture(file)]);
  const fatal = result?.messages.filter((m) => m.fatal) ?? [];
  if (fatal.length > 0) throw new Error(`Parse error in ${file}: ${fatal[0]?.message}`);
  return (result?.messages ?? []).filter((m) => m.severity === 2).map((m) => m.ruleId ?? 'unknown');
}

describe('architecture boundaries are enforced by ESLint', () => {
  it.each([
    ['core/bad-imports-node.ts', 'no-restricted-imports', 'core must not use Node APIs'],
    ['core/bad-uses-fetch.ts', 'no-restricted-globals', 'core must not make network calls'],
    ['core/bad-imports-server.ts', 'boundaries/dependencies', 'core must not depend on adapters'],
    [
      'contract/bad-imports-express.ts',
      'no-restricted-imports',
      'contract must not depend on Express',
    ],
    [
      'server/storage/bad-imports-express.ts',
      'no-restricted-imports',
      'Express lives only in server/http',
    ],
    [
      'web/features/beta/bad-deep-import.ts',
      'boundaries/dependencies',
      'no deep import into another feature',
    ],
    [
      'web/features/beta/bad-alias-deep-import.ts',
      'no-restricted-imports',
      'no deep import via alias',
    ],
    [
      'web/features/beta/bad-imports-server.ts',
      'boundaries/dependencies',
      'web must not import server',
    ],
    [
      'web/features/beta/bad-uses-fetch.ts',
      'no-restricted-globals',
      'features talk to the server via web/api',
    ],
    [
      'web/shared/ui/bad-imports-feature.ts',
      'boundaries/dependencies',
      'shared must not know features',
    ],
    ['web/api/bad-imports-feature.ts', 'boundaries/dependencies', 'web/api must not know features'],
  ])(
    '%s → %s (%s)',
    async (file, rule) => {
      expect(await ruleIds(file)).toContain(rule);
    },
    LINT_TIMEOUT_MS,
  );

  it.each([
    [
      'web/features/beta/ok-public-api.ts',
      'feature → other feature index, single-file feature, shared, contract',
    ],
    ['server/storage/ok-core.ts', 'adapter → core and Node APIs'],
    ['contract/routes.ts', 'contract → core model'],
    ['web/features/alpha/index.ts', 'feature → its own internals'],
  ])(
    '%s is allowed (%s)',
    async (file) => {
      expect(await ruleIds(file)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});
