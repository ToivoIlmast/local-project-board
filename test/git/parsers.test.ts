import { z } from 'zod';
import { gitBranchSchema, gitCommitSchema, gitStatusSchema } from '../../src/core/model/index.js';
import { parseBranches, parseCommits, parseStatus } from '../../src/server/git/parsers.js';

const NUL = '\0';
const US = '\u001f';
const RS = '\u001e';

/** Recorded from `git status --porcelain=v2 --branch -z` (git 2.43). */
const recordedStatus = [
  '# branch.oid 43dc8d35fcab058ba014f826d61415150d80fc99',
  '# branch.head main',
  '1 .M N... 100644 100644 100644 7898192261 7898192261 a.txt',
  '1 D. N... 100644 000000 000000 6178079822 0000000000 b file.txt',
  '2 R. N... 100644 100644 100644 f2ad6c76f0 f2ad6c76f0 R100 notes.txt',
  '2024-notes.txt',
  '1 A. N... 000000 100644 100644 0000000000 587be6b4c3 staged-new.txt',
  '? untracked.txt',
  '',
].join(NUL);

describe('parseStatus', () => {
  it('reads the branch from the porcelain header', () => {
    const status = parseStatus(recordedStatus);
    expect(status.branch).toBe('main');
    expect(status.detached).toBe(false);
  });

  it('reports a detached HEAD without inventing a branch name', () => {
    const status = parseStatus(`# branch.oid 43dc8d35${NUL}# branch.head (detached)${NUL}`);
    expect(status.branch).toBeNull();
    expect(status.detached).toBe(true);
  });

  it('keeps the unborn branch of a repository without commits and calls it clean', () => {
    const status = parseStatus(`# branch.oid (initial)${NUL}# branch.head main${NUL}`);
    expect(status).toEqual({ branch: 'main', detached: false, clean: true, files: [] });
  });

  it('separates the index side from the worktree side of a change', () => {
    const status = parseStatus(recordedStatus);
    expect(status.files).toEqual([
      { path: 'a.txt', staged: false, status: 'modified' },
      { path: 'b file.txt', staged: true, status: 'deleted' },
      { path: 'notes.txt', staged: true, status: 'renamed' },
      { path: 'staged-new.txt', staged: true, status: 'added' },
      { path: 'untracked.txt', staged: false, status: 'untracked' },
    ]);
  });

  it('reports a file that is both staged and changed again as two entries', () => {
    const status = parseStatus(
      `# branch.head main${NUL}1 MM N... 100644 100644 100644 aaaa bbbb a.txt${NUL}`,
    );
    expect(status.files).toEqual([
      { path: 'a.txt', staged: true, status: 'modified' },
      { path: 'a.txt', staged: false, status: 'modified' },
    ]);
  });

  it('skips the original path of a rename, even when it looks like a record', () => {
    // The old path is a record of its own; "2024-notes.txt" starts like a rename record.
    const status = parseStatus(recordedStatus);
    const paths = status.files.map((file) => file.path);
    expect(paths).not.toContain('2024-notes.txt');
    expect(paths).toContain('staged-new.txt');
  });

  it('normalises an unmerged path to an unstaged modification', () => {
    const status = parseStatus(
      `# branch.head main${NUL}u UU N... 100644 100644 100644 100644 aaaa bbbb cccc both.txt${NUL}`,
    );
    expect(status.files).toEqual([{ path: 'both.txt', staged: false, status: 'modified' }]);
  });

  it('ignores ignored files and records it does not know', () => {
    const status = parseStatus(
      `# branch.head main${NUL}! ignored.txt${NUL}# branch.ab +1 -0${NUL}nonsense${NUL}`,
    );
    expect(status.files).toEqual([]);
    expect(status.clean).toBe(true);
  });

  it('is not clean when the only change is an untracked file', () => {
    const status = parseStatus(`# branch.head main${NUL}? new.txt${NUL}`);
    expect(status.clean).toBe(false);
  });

  it('answers with an empty status for empty output instead of throwing', () => {
    expect(parseStatus('')).toEqual({ branch: null, detached: false, clean: true, files: [] });
  });

  it('produces output that satisfies the contract schema', () => {
    expect(() => gitStatusSchema.parse(parseStatus(recordedStatus))).not.toThrow();
  });
});

describe('parseBranches', () => {
  const recorded = `*${US}main\n ${US}feat/git-adapter\n`;

  it('marks the checked out branch', () => {
    expect(parseBranches(recorded)).toEqual([
      { name: 'main', current: true },
      { name: 'feat/git-adapter', current: false },
    ]);
  });

  it('marks no branch as current on a detached HEAD', () => {
    expect(parseBranches(` ${US}main\n ${US}feat/x\n`)).toEqual([
      { name: 'main', current: false },
      { name: 'feat/x', current: false },
    ]);
  });

  it('returns nothing for a repository without refs', () => {
    expect(parseBranches('')).toEqual([]);
  });

  it('skips records it cannot read', () => {
    expect(parseBranches(`*${US}main\nbroken\n${US}\n`)).toEqual([{ name: 'main', current: true }]);
  });

  it('produces output that satisfies the contract schema', () => {
    expect(() => z.array(gitBranchSchema).parse(parseBranches(recorded))).not.toThrow();
  });
});

describe('parseCommits', () => {
  /** Recorded from `git log --pretty=format:%H%x1f%s%x1f%an%x1f%aI%x1e`. */
  const recorded =
    `43dc8d35fcab058ba014f826d61415150d80fc99${US}Extract the git status parser${US}Toivo Ilmast${US}2026-09-23T12:12:10+00:00${RS}\n` +
    `eb93f0edb2c4c3162a2862e91ce1f936dade7f26${US}first commit${US}Toivo Ilmast${US}2026-09-21T09:00:00+00:00${RS}`;

  it('reads sha, subject and author of every commit', () => {
    const commits = parseCommits(recorded);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      sha: '43dc8d35fcab058ba014f826d61415150d80fc99',
      subject: 'Extract the git status parser',
      author: 'Toivo Ilmast',
    });
  });

  it('normalises the author date to UTC, because the contract requires it', () => {
    expect(parseCommits(recorded)[0]?.date).toBe('2026-09-23T12:12:10.000Z');
    expect(
      parseCommits(`aa${'0'.repeat(38)}${US}s${US}a${US}2026-09-23T15:12:10+03:00${RS}`)[0]?.date,
    ).toBe('2026-09-23T12:12:10.000Z');
  });

  it('returns nothing for a repository without commits', () => {
    expect(parseCommits('')).toEqual([]);
  });

  it('skips a record that is not a commit instead of inventing fields', () => {
    const commits = parseCommits(
      `not-a-sha${US}s${US}a${US}2026-09-21T09:00:00+00:00${RS}\n` +
        `43dc8d35fcab058ba014f826d61415150d80fc99${US}kept${US}a${US}2026-09-21T09:00:00+00:00${RS}\n` +
        `43dc8d35fcab058ba014f826d61415150d80fc99${US}no date${RS}`,
    );
    expect(commits.map((commit) => commit.subject)).toEqual(['kept']);
  });

  it('skips a record whose subject contains the field separator, instead of garbling it', () => {
    // A commit message may contain any byte, including the separator git formats with.
    const commits = parseCommits(
      `43dc8d35fcab058ba014f826d61415150d80fc99${US}sub${US}ject${US}A${US}2026-09-21T09:00:00+00:00${RS}`,
    );
    expect(commits).toEqual([]);
  });

  it('keeps a subject that contains spaces and punctuation', () => {
    const commits = parseCommits(
      `43dc8d35fcab058ba014f826d61415150d80fc99${US}fix: don't split; keep it${US}A B${US}2026-09-21T09:00:00+00:00${RS}`,
    );
    expect(commits[0]?.subject).toBe("fix: don't split; keep it");
  });

  it('produces output that satisfies the contract schema', () => {
    expect(() => z.array(gitCommitSchema).parse(parseCommits(recorded))).not.toThrow();
  });
});
