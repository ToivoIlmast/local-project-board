import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { BoardError } from '../../src/core/errors.js';
import { gitReader } from '../../src/server/git/index.js';
import { repoWithCommit } from '../support/gitRepo.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

afterAll(cleanTmpDirs);

let root: string;

beforeEach(async () => {
  root = await repoWithCommit(await tmpDir());
});

/** Values that must never reach git as an option or as a second argument. */
const badRefs = ['--upload-pack=touch pwned', '-n1', 'a b', 'a;rm -rf /', '--help', '', 'a\nb'];

describe('git arguments', () => {
  it.each(badRefs)('refuses %p as a ref', async (ref) => {
    const reader = gitReader({ root });
    await expect(reader.commits({ ref, limit: 1 })).rejects.toMatchObject({
      code: 'INVALID_GIT_ARGUMENT',
    });
    await expect(reader.diff({ ref })).rejects.toBeInstanceOf(BoardError);
  });

  it.each(['--output=pwned.txt', '-n', ''])('refuses %p as a path', async (path) => {
    await expect(gitReader({ root }).diff({ path })).rejects.toMatchObject({
      code: 'INVALID_GIT_ARGUMENT',
    });
  });

  it('refuses a bad ref before running git at all', async () => {
    await expect(
      gitReader({ root }).commits({ ref: '--upload-pack=touch pwned', limit: 1 }),
    ).rejects.toThrow();
    await expect(access(join(root, 'pwned'))).rejects.toThrow();
  });

  it('passes a path that looks like a shell command to git verbatim', async () => {
    // execFile, not a shell: these are pathspecs that match nothing, not commands.
    const reader = gitReader({ root });

    await expect(reader.diff({ path: '$(touch pwned)' })).resolves.toEqual({
      text: '',
      truncated: false,
    });
    await expect(reader.diff({ path: 'a.txt; touch pwned2' })).resolves.toEqual({
      text: '',
      truncated: false,
    });

    await expect(access(join(root, 'pwned'))).rejects.toThrow();
    await expect(access(join(root, 'pwned2'))).rejects.toThrow();
  });
});
