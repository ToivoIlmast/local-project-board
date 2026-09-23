import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveBoardRoot } from '../../src/server/project/boardRoot.js';
import { git, repoWithCommit } from '../support/gitRepo.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

afterAll(cleanTmpDirs);

/** The board root is the main worktree, so every worktree of a repository shares one board. */
describe('resolveBoardRoot', () => {
  it('climbs from a subdirectory to the repository root', async () => {
    const root = await repoWithCommit(await tmpDir());
    const nested = join(root, 'src', 'server');
    await mkdir(nested, { recursive: true });

    expect(await resolveBoardRoot(nested)).toBe(await realpath(root));
  });

  it('resolves a linked worktree to the main checkout, not to the worktree', async () => {
    const main = await repoWithCommit(await tmpDir());
    const worktree = join(await tmpDir(), 'wt');
    await git(main, 'worktree', 'add', '-q', '-b', 'feat/wt', worktree);

    expect(await resolveBoardRoot(worktree)).toBe(await realpath(main));
    expect(await resolveBoardRoot(worktree)).not.toBe(await realpath(worktree));
  });

  it('falls back to the current directory outside a repository', async () => {
    const dir = await tmpDir();
    expect(await resolveBoardRoot(dir)).toBe(await realpath(dir));
  });

  it('falls back to the current directory when git is missing', async () => {
    const root = await repoWithCommit(await tmpDir());
    expect(await resolveBoardRoot(root, { gitBinary: 'git-that-does-not-exist' })).toBe(
      await realpath(root),
    );
  });
});
