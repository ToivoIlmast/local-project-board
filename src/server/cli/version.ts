import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'local-project-board';

/**
 * The version of this package, read from its own package.json. The file is found by walking
 * up from `from`, so the answer is the same from `src/` (tests), `dist/node/` and an installed
 * package; a package.json of something else on the way is skipped. When no version can be
 * read it fails: a made-up version would be reported as if it were true.
 */
export async function readPackageVersion(
  from: string = dirname(fileURLToPath(import.meta.url)),
): Promise<string> {
  for (let dir = from; ; dir = dirname(dir)) {
    const version = await versionIn(join(dir, 'package.json'));
    if (version !== undefined) return version;
    if (dirname(dir) === dir) {
      throw new Error(`Cannot read the version of ${PACKAGE_NAME}: no package.json names it.`);
    }
  }
}

/** The version in a package.json that is this package's own; undefined for any other file. */
async function versionIn(file: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as { name?: unknown; version?: unknown };
    return parsed.name === PACKAGE_NAME && typeof parsed.version === 'string'
      ? parsed.version
      : undefined;
  } catch {
    return undefined;
  }
}
