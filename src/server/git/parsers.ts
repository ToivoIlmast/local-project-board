import type { GitBranch, GitCommit, GitFileChange, GitStatus } from '../../core/model/index.js';

/** Unit and record separators: git emits them, they cannot appear in a ref or a subject. */
const US = '\u001f';
const RS = '\u001e';

export const STATUS_ARGS = ['status', '--porcelain=v2', '--branch', '-z'];
export const BRANCH_FORMAT = '%(HEAD)%1f%(refname:short)';
export const LOG_FORMAT = '%H%x1f%s%x1f%an%x1f%aI%x1e';

const HEAD_PREFIX = '# branch.head ';
const DETACHED = '(detached)';
const SHA = /^[0-9a-f]{40}$/;

const EMPTY_STATUS: GitStatus = { branch: null, detached: false, clean: true, files: [] };

/**
 * Parses `git status --porcelain=v2 --branch -z`. Records are NUL-terminated, so paths with
 * spaces or newlines survive; a rename record is followed by a second record, its old path.
 */
export function parseStatus(text: string): GitStatus {
  if (text === '') return EMPTY_STATUS;

  const records = text.split('\0');
  const files: GitFileChange[] = [];
  let branch: string | null = null;
  let detached = false;

  for (let index = 0; index < records.length; index++) {
    const record = records[index] ?? '';
    if (record === '') continue;

    if (record.startsWith(HEAD_PREFIX)) {
      const value = record.slice(HEAD_PREFIX.length);
      // A detached HEAD has no branch; no name is invented for it.
      detached = value === DETACHED;
      branch = detached ? null : value || null;
      continue;
    }
    if (record.startsWith('# ')) continue;

    switch (record[0]) {
      case '1':
        files.push(...trackedChanges(record, 8));
        break;
      case '2':
        files.push(...trackedChanges(record, 9));
        index += 1; // the old path of the rename, not a file of its own
        break;
      case 'u':
        files.push(...unmergedChange(record));
        break;
      case '?':
        files.push(...untrackedChange(record));
        break;
      default:
        break; // ignored files ("!") and anything a newer git may add
    }
  }

  return { branch, detached, clean: files.length === 0, files };
}

/** `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`, and one field more for a rename. */
function trackedChanges(record: string, pathAt: number): GitFileChange[] {
  const fields = record.split(' ');
  const path = fields.slice(pathAt).join(' ');
  const xy = fields[1] ?? '';
  if (path === '' || xy.length < 2) return [];

  const changes: GitFileChange[] = [];
  const staged = changeStatus(xy[0]);
  const worktree = changeStatus(xy[1]);
  if (staged) changes.push({ path, staged: true, status: staged });
  if (worktree) changes.push({ path, staged: false, status: worktree });
  return changes;
}

/** An unmerged path is reported as a change in the worktree; the board has no merge UI. */
function unmergedChange(record: string): GitFileChange[] {
  const fields = record.split(' ');
  const path = fields.slice(10).join(' ');
  return path === '' ? [] : [{ path, staged: false, status: 'modified' }];
}

function untrackedChange(record: string): GitFileChange[] {
  const path = record.slice(2);
  return path === '' ? [] : [{ path, staged: false, status: 'untracked' }];
}

function changeStatus(code: string | undefined): GitFileChange['status'] | null {
  switch (code) {
    case 'M':
    case 'T':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'added';
    default:
      return null; // "." means unchanged on that side
  }
}

/** Parses `git for-each-ref --format=BRANCH_FORMAT refs/heads`. */
export function parseBranches(text: string): GitBranch[] {
  const branches: GitBranch[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const [head, name] = line.split(US);
    if (name === undefined || name === '') continue;
    branches.push({ name, current: head === '*' });
  }
  return branches;
}

/** Parses `git log --pretty=format:LOG_FORMAT`. Anything unreadable is skipped, never guessed. */
export function parseCommits(text: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of text.split(RS)) {
    const fields = record.replace(/^[\r\n]+/, '').split(US);
    if (fields.length !== 4) continue;

    const [sha, subject, author, rawDate] = fields as [string, string, string, string];
    const date = utcDate(rawDate);
    if (!SHA.test(sha) || date === null) continue;

    commits.push({ sha, subject, author, date });
  }
  return commits;
}

/** git dates carry the author's offset; the contract requires UTC. Same instant, one form. */
function utcDate(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
