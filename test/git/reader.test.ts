import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { gitCommitSchema, gitStatusSchema } from '../../src/core/model/index.js';
import type { GitReader } from '../../src/core/ports.js';
import { gitReader, nullGitReader } from '../../src/server/git/index.js';
import { commitAll, git, initRepo, repoWithCommit, writeRepoFile } from '../support/gitRepo.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

afterAll(cleanTmpDirs);

const EMPTY_STATUS = { branch: null, detached: false, clean: true, files: [] };

/** Every answer of an unusable reader, so "no git" can never become an exception. */
async function readEverything(reader: GitReader) {
  return {
    available: await reader.available(),
    currentBranch: await reader.currentBranch(),
    branches: await reader.branches(),
    status: await reader.status(),
    commits: await reader.commits({ limit: 10 }),
    diff: await reader.diff({}),
  };
}

const unusable = {
  available: false,
  currentBranch: { name: null, detached: false },
  branches: [],
  status: EMPTY_STATUS,
  commits: [],
  diff: { text: '', truncated: false },
};

describe('a repository with commits', () => {
  let root: string;
  let reader: GitReader;

  beforeEach(async () => {
    root = await repoWithCommit(await tmpDir());
    reader = gitReader({ root });
  });

  it('is available and reports the checked out branch', async () => {
    expect(await reader.available()).toBe(true);
    expect(await reader.currentBranch()).toEqual({ name: 'main', detached: false });
  });

  it('lists local branches with the current one marked', async () => {
    await git(root, 'branch', 'feat/git-adapter');
    expect(await reader.branches()).toEqual([
      { name: 'feat/git-adapter', current: false },
      { name: 'main', current: true },
    ]);
  });

  it('reports a clean tree and then the change made to it', async () => {
    expect(await reader.status()).toEqual({ ...EMPTY_STATUS, branch: 'main' });

    await writeRepoFile(root, 'a.txt', 'changed\n');
    await writeRepoFile(root, 'new.txt', 'new\n');
    const status = await reader.status();

    expect(status.clean).toBe(false);
    expect(status.files).toEqual([
      { path: 'a.txt', staged: false, status: 'modified' },
      { path: 'new.txt', staged: false, status: 'untracked' },
    ]);
    expect(() => gitStatusSchema.parse(status)).not.toThrow();
  });

  it('reads commits, newest first, with the date in UTC', async () => {
    await writeRepoFile(root, 'a.txt', 'second\n');
    await commitAll(root, 'second commit');

    const commits = await reader.commits({ limit: 10 });

    expect(commits.map((commit) => commit.subject)).toEqual(['second commit', 'first commit']);
    expect(commits[0]).toMatchObject({ author: 'Test Author', date: '2026-09-21T09:00:00.000Z' });
    expect(() => z.array(gitCommitSchema).parse(commits)).not.toThrow();
  });

  it('honours the commit limit and the ref', async () => {
    await writeRepoFile(root, 'a.txt', 'second\n');
    await commitAll(root, 'second commit');
    await git(root, 'checkout', '-q', '-b', 'side');
    await writeRepoFile(root, 'a.txt', 'third\n');
    await commitAll(root, 'third commit');

    expect(await reader.commits({ limit: 1 })).toHaveLength(1);
    expect((await reader.commits({ ref: 'main', limit: 10 })).map((c) => c.subject)).toEqual([
      'second commit',
      'first commit',
    ]);
  });

  it('diffs the working tree, the index and a single path', async () => {
    await writeRepoFile(root, 'a.txt', 'changed\n');
    await writeRepoFile(root, 'b.txt', 'b\n');
    await git(root, 'add', 'b.txt');

    const worktree = await reader.diff({});
    expect(worktree.text).toContain('+changed');
    expect(worktree.truncated).toBe(false);

    const staged = await reader.diff({ staged: true });
    expect(staged.text).toContain('b.txt');
    expect(staged.text).not.toContain('+changed');

    const scoped = await reader.diff({ path: 'a.txt' });
    expect(scoped.text).toContain('a.txt');
    expect(scoped.text).not.toContain('b.txt');
  });

  it('changes nothing in the repository (the adapter is read-only)', async () => {
    await writeRepoFile(root, 'a.txt', 'changed\n');
    const before = await git(root, 'status', '--porcelain=v2', '--branch');

    await readEverything(reader);

    expect(await git(root, 'status', '--porcelain=v2', '--branch')).toBe(before);
    expect(await git(root, 'stash', 'list')).toBe('');
  });

  it('truncates a diff that is too large instead of returning it whole', async () => {
    await writeRepoFile(root, 'a.txt', `${'line\n'.repeat(20_000)}`);
    const limited = gitReader({ root, maxDiffChars: 1_000 });

    const diff = await limited.diff({});

    expect(diff.truncated).toBe(true);
    expect(diff.text.length).toBeLessThanOrEqual(1_000);
    expect(diff.text.length).toBeGreaterThan(0);
  });
});

describe('a repository without commits', () => {
  it('answers with the unborn branch and no commits', async () => {
    const root = await initRepo(await tmpDir());
    const reader = gitReader({ root });

    expect(await reader.available()).toBe(true);
    expect(await reader.currentBranch()).toEqual({ name: 'main', detached: false });
    expect(await reader.branches()).toEqual([]);
    expect(await reader.commits({ limit: 10 })).toEqual([]);
    expect(await reader.status()).toEqual({ ...EMPTY_STATUS, branch: 'main' });
    expect(await reader.diff({})).toEqual({ text: '', truncated: false });
  });
});

describe('a detached HEAD', () => {
  it('has no branch name, and no branch is current', async () => {
    const root = await repoWithCommit(await tmpDir());
    await git(root, 'branch', 'feat/x');
    await git(root, 'checkout', '-q', '--detach', 'HEAD');
    const reader = gitReader({ root });

    expect(await reader.currentBranch()).toEqual({ name: null, detached: true });
    expect(await reader.status()).toMatchObject({ branch: null, detached: true });
    expect(await reader.branches()).toEqual([
      { name: 'feat/x', current: false },
      { name: 'main', current: false },
    ]);
  });
});

describe('a linked worktree', () => {
  it('reports the branch of the worktree, not of the main checkout', async () => {
    const main = await repoWithCommit(await tmpDir());
    const worktree = join(await tmpDir(), 'wt');
    await git(main, 'worktree', 'add', '-q', '-b', 'feat/wt', worktree);

    const reader = gitReader({ root: worktree });

    expect(await reader.available()).toBe(true);
    expect(await reader.currentBranch()).toEqual({ name: 'feat/wt', detached: false });
    expect(await reader.branches()).toEqual([
      { name: 'feat/wt', current: true },
      { name: 'main', current: false },
    ]);
  });
});

describe('a directory that is not a repository', () => {
  it('answers every question without throwing', async () => {
    const reader = gitReader({ root: await tmpDir() });
    expect(await readEverything(reader)).toEqual(unusable);
  });

  it('does not create a repository of its own', async () => {
    const root = await tmpDir();
    await readEverything(gitReader({ root }));
    await expect(access(join(root, '.git'))).rejects.toThrow();
  });
});

describe('a machine without git', () => {
  it('answers every question without throwing', async () => {
    const root = await repoWithCommit(await tmpDir());
    const reader = gitReader({ root, gitBinary: 'git-that-does-not-exist' });
    expect(await readEverything(reader)).toEqual(unusable);
  });
});

describe('the null reader', () => {
  it('gives the same answers as a reader that cannot use git', async () => {
    expect(await readEverything(nullGitReader())).toEqual(unusable);
  });

  it('does not invent a branch for a task that names one', async () => {
    expect((await nullGitReader().currentBranch()).name).toBeNull();
  });
});

describe('a broken repository', () => {
  it('reports a git that refuses to run as unavailable rather than crashing', async () => {
    const root = await tmpDir();
    // A file where the repository should be: git exits with an error on every command.
    await writeFile(join(root, '.git'), 'not a repository\n', 'utf8');
    expect(await readEverything(gitReader({ root }))).toEqual(unusable);
  });

  it('answers with nothing when a ref does not exist', async () => {
    const root = await repoWithCommit(await tmpDir());
    const reader = gitReader({ root });
    await expect(reader.commits({ ref: 'no-such-branch', limit: 10 })).resolves.toEqual([]);
    await expect(reader.diff({ ref: 'no-such-branch' })).resolves.toEqual({
      text: '',
      truncated: false,
    });
  });
});
