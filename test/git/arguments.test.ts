import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitReader } from '../../src/server/git/index.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

afterAll(cleanTmpDirs);

/**
 * What git actually receives. A stand-in binary records its arguments, so the separator
 * before paths and the refusal to run at all are observable, not assumed.
 */
const posix = process.platform !== 'win32';

(posix ? describe : describe.skip)('the arguments git receives', () => {
  let root: string;
  let log: string;
  let fakeGit: string;

  beforeEach(async () => {
    root = await tmpDir();
    log = join(root, 'args.log');
    fakeGit = join(root, 'fake-git');
    await writeFile(
      fakeGit,
      `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" >> ${log}; done\n`,
    );
    await chmod(fakeGit, 0o755);
  });

  const recorded = async (): Promise<string[]> =>
    (await readFile(log, 'utf8')).split('\n').slice(0, -1);

  it('puts every path after "--", where git cannot read it as an option', async () => {
    await gitReader({ root, gitBinary: fakeGit }).diff({ path: 'a.txt' });

    const args = await recorded();
    expect(args).toContain('a.txt');
    expect(args.indexOf('--')).toBeGreaterThanOrEqual(0);
    expect(args.indexOf('--')).toBeLessThan(args.indexOf('a.txt'));
  });

  it('separates a ref from the path list as well', async () => {
    await gitReader({ root, gitBinary: fakeGit }).commits({ ref: 'main', limit: 5 });

    const args = await recorded();
    expect(args.slice(args.indexOf('-n'), args.indexOf('-n') + 2)).toEqual(['-n', '5']);
    expect(args.indexOf('main')).toBeLessThan(args.indexOf('--'));
    expect(args.at(-1)).toBe('--');
  });

  it('clamps the commit count, however the caller asks', async () => {
    const reader = gitReader({ root, gitBinary: fakeGit });

    await reader.commits({ limit: 10_000 });
    expect((await recorded()).slice(-3, -1)).toEqual(['-n', '200']);

    await reader.commits({ limit: 0 });
    expect((await recorded()).slice(-3, -1)).toEqual(['-n', '1']);
  });

  it('does not run git at all when a ref is invalid', async () => {
    const reader = gitReader({ root, gitBinary: fakeGit });

    await expect(reader.commits({ ref: '--upload-pack=x', limit: 1 })).rejects.toThrow();
    await expect(reader.diff({ path: '-n' })).rejects.toThrow();

    await expect(readFile(log, 'utf8')).rejects.toThrow();
  });
});
