import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPackageVersion } from '../../src/server/cli/version.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

afterEach(cleanTmpDirs);

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

describe('readPackageVersion', () => {
  it('reads the real version from sources, never the 0.0.0 placeholder', async () => {
    const version = await readPackageVersion();
    expect(version).toBe(packageJson.version);
    expect(version).not.toBe('0.0.0');
  });

  it('walks up from where it starts to the package.json of this package', async () => {
    const dir = await tmpDir();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'local-project-board', version: '9.8.7' }),
    );
    await mkdir(join(dir, 'dist', 'node'), { recursive: true });
    expect(await readPackageVersion(join(dir, 'dist', 'node'))).toBe('9.8.7');
  });

  it('skips a package.json that belongs to something else', async () => {
    const dir = await tmpDir();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'local-project-board', version: '1.2.3' }),
    );
    await mkdir(join(dir, 'inner'), { recursive: true });
    await writeFile(join(dir, 'inner', 'package.json'), JSON.stringify({ type: 'module' }));
    expect(await readPackageVersion(join(dir, 'inner'))).toBe('1.2.3');
  });

  it('fails explicitly when no version can be read', async () => {
    const dir = await tmpDir();
    await expect(readPackageVersion(dir)).rejects.toThrow(/version of local-project-board/);

    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'local-project-board' }));
    await expect(readPackageVersion(dir)).rejects.toThrow(/version of local-project-board/);
  });
});
