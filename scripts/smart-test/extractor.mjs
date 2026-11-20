// @ts-check
/**
 * Jest's dependency extractor plus the imports Jest leaves out on purpose: `import type` and
 * `export type … from`. They do not exist at run time, but ts-jest type-checks every test, so a
 * change to a type can fail a test that only imports types. Used only by the selector's own
 * dependency graph (scripts/smart-test/jest.mjs); the configuration of real runs is untouched.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TYPE_IMPORT = /\b(?:import|export)\s+type\s+(?:[^'"]+?\s+from\s+)?(['"])([^'"\n]+)\1/g;

/**
 * @param {string} code
 * @param {string} filePath
 * @param {(code: string) => Iterable<string>} defaultExtract
 * @returns {Set<string>}
 */
export function extract(code, filePath, defaultExtract) {
  const found = new Set(defaultExtract(code));
  for (const match of code.matchAll(TYPE_IMPORT)) {
    if (match[2] !== undefined) found.add(match[2]);
  }
  return found;
}

/** A graph built with this extractor is cached apart from Jest's own, and rebuilt when it changes. */
export function getCacheKey() {
  return createHash('sha1')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex');
}
