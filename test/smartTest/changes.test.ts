import { jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { collectChanges, parseNameStatus } from '../../scripts/smart-test/changes.mjs';
import { commitAll, git, initRepo, writeRepoFile } from '../support/gitRepo.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

/**
 * Every case builds a real repository and asks git a dozen questions; on Windows, and while the
 * rest of the suite runs, one git process can take a second.
 */
jest.setTimeout(30_000);

afterEach(cleanTmpDirs);

/** `main` with three files, and a branch `feature` checked out from it. */
async function branchRepo(): Promise<string> {
  const dir = await initRepo(await tmpDir());
  await mkdir(join(dir, 'src'));
  await mkdir(join(dir, 'docs'));
  await writeRepoFile(dir, 'src/a.ts', 'export const a = 1;\n');
  await writeRepoFile(dir, 'src/b.ts', 'export const b = 1;\n');
  await writeRepoFile(dir, 'docs/x.md', '# x\n');
  await writeRepoFile(dir, '.gitignore', 'ignored/\n');
  await commitAll(dir, 'base');
  await git(dir, 'checkout', '-q', '-b', 'feature');
  return dir;
}

async function found(dir: string, base?: string) {
  const result = await collectChanges({ root: dir, base });
  if (!result.ok) throw new Error(`expected changes, got: ${result.reason}`);
  return result;
}

async function reason(dir: string, base?: string): Promise<string> {
  const result = await collectChanges({ root: dir, base });
  if (result.ok) throw new Error('expected git to be refused');
  return result.reason;
}

describe('collectChanges: what this branch changed', () => {
  it('nothing on a fresh branch', async () => {
    const dir = await branchRepo();
    const result = await found(dir);
    expect(result).toMatchObject({ changes: [], base: 'main', commits: 0 });
  });

  it('committed, staged, unstaged and untracked changes together', async () => {
    const dir = await branchRepo();
    await writeRepoFile(dir, 'src/a.ts', 'export const a = 2;\n');
    await commitAll(dir, 'committed on the branch');
    await writeRepoFile(dir, 'src/staged.ts', 'export {};\n');
    await git(dir, 'add', 'src/staged.ts');
    await writeRepoFile(dir, 'docs/x.md', '# x, edited\n');
    await writeRepoFile(dir, 'src/untracked.ts', 'export {};\n');
    await rm(join(dir, 'src/b.ts'));
    const result = await found(dir);
    expect(result.commits).toBe(1);
    expect(result.changes).toEqual([
      { status: 'M', path: 'docs/x.md' },
      { status: 'M', path: 'src/a.ts' },
      { status: 'D', path: 'src/b.ts' },
      { status: 'A', path: 'src/staged.ts' },
      { status: 'A', path: 'src/untracked.ts' },
    ]);
  });

  it('a rename is the old path deleted and the new one added, staged or not', async () => {
    const dir = await branchRepo();
    await git(dir, 'mv', 'src/a.ts', 'src/renamed.ts');
    await rename(join(dir, 'src/b.ts'), join(dir, 'src/moved.ts'));
    expect((await found(dir)).changes).toEqual([
      { status: 'D', path: 'src/a.ts' },
      { status: 'D', path: 'src/b.ts' },
      { status: 'A', path: 'src/moved.ts' },
      { status: 'A', path: 'src/renamed.ts' },
    ]);
  });

  it('a committed rename is followed too', async () => {
    const dir = await branchRepo();
    await git(dir, 'mv', 'src/a.ts', 'src/renamed.ts');
    await commitAll(dir, 'rename');
    expect((await found(dir)).changes).toEqual([
      { status: 'D', path: 'src/a.ts' },
      { status: 'A', path: 'src/renamed.ts' },
    ]);
  });

  it('ignored files are not changes; names with spaces and non-ASCII letters are kept intact', async () => {
    const dir = await branchRepo();
    await mkdir(join(dir, 'ignored'));
    await writeRepoFile(dir, 'ignored/x.ts', 'x\n');
    await writeRepoFile(dir, 'docs/ä ö.md', 'x\n');
    expect((await found(dir)).changes).toEqual([{ status: 'A', path: 'docs/ä ö.md' }]);
  });

  it('compares with the given base', async () => {
    const dir = await branchRepo();
    await writeRepoFile(dir, 'src/a.ts', 'export const a = 2;\n');
    await commitAll(dir, 'one');
    await git(dir, 'branch', 'mid');
    await writeRepoFile(dir, 'src/b.ts', 'export const b = 2;\n');
    await commitAll(dir, 'two');
    expect((await found(dir, 'mid')).changes).toEqual([{ status: 'M', path: 'src/b.ts' }]);
  });

  it('on the base branch itself without a remote: only what is not committed, and it says so', async () => {
    const dir = await branchRepo();
    await git(dir, 'checkout', '-q', 'main');
    await writeRepoFile(dir, 'src/a.ts', 'export const a = 3;\n');
    const result = await found(dir);
    expect(result.changes).toEqual([{ status: 'M', path: 'src/a.ts' }]);
    expect(result.notes[0]).toMatch(/only changes that are not committed/);
  });
});

describe('collectChanges refuses whenever git cannot answer reliably (→ Full mode)', () => {
  it('outside a git repository', async () => {
    expect(await reason(await tmpDir())).toMatch(/not a git checkout/);
  });

  it('in a directory that merely sits inside another repository', async () => {
    const dir = await branchRepo();
    await mkdir(join(dir, 'inner'));
    expect(await reason(join(dir, 'inner'))).toMatch(/not this project's root/);
  });

  it('without a commit', async () => {
    const dir = await initRepo(await tmpDir());
    expect(await reason(dir)).toMatch(/no commits yet/);
  });

  it('in the middle of a merge with conflicts', async () => {
    const dir = await branchRepo();
    await writeRepoFile(dir, 'src/a.ts', 'feature\n');
    await commitAll(dir, 'feature side');
    await git(dir, 'checkout', '-q', 'main');
    await writeRepoFile(dir, 'src/a.ts', 'main\n');
    await commitAll(dir, 'main side');
    await git(dir, 'checkout', '-q', 'feature');
    await expect(git(dir, 'merge', 'main')).rejects.toThrow();
    expect(await reason(dir)).toMatch(/in the middle of a merge/);
  });

  it('when no base branch exists', async () => {
    const dir = await tmpDir();
    await git(dir, 'init', '-q', '-b', 'trunk');
    await writeRepoFile(dir, 'a.txt', 'a\n');
    await commitAll(dir, 'only commit');
    expect(await reason(dir)).toMatch(/no base branch found/);
  });

  it('when the given base is not a commit', async () => {
    const dir = await branchRepo();
    expect(await reason(dir, 'no-such-branch')).toMatch(/`no-such-branch` is not a commit/);
  });

  it('when the branch shares no history with the base', async () => {
    const dir = await branchRepo();
    await git(dir, 'checkout', '-q', '--orphan', 'island');
    await commitAll(dir, 'unrelated root');
    expect(await reason(dir)).toMatch(/no common history/);
  });

  it('in a shallow clone', async () => {
    const dir = await branchRepo();
    await writeRepoFile(dir, 'src/a.ts', 'x\n');
    await commitAll(dir, 'second');
    const clone = join(await tmpDir(), 'clone');
    execFileSync('git', ['clone', '-q', '--depth', '1', '-b', 'feature', `file://${dir}`, clone]);
    expect(await reason(clone)).toMatch(/shallow/);
  });
});

describe('parseNameStatus', () => {
  it('reads -z output: renames, copies, type changes', () => {
    const out = [
      'M',
      'a.ts',
      'R087',
      'old.ts',
      'new.ts',
      'C100',
      'src.ts',
      'copy.ts',
      'T',
      'link',
      '',
    ];
    expect(parseNameStatus(out.join('\0'))).toEqual([
      { status: 'M', path: 'a.ts' },
      { status: 'D', path: 'old.ts' },
      { status: 'A', path: 'new.ts' },
      { status: 'A', path: 'copy.ts' },
      { status: 'M', path: 'link' },
    ]);
  });
});
