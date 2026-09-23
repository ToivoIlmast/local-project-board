import { BoardError } from '../../core/errors.js';
import { gitPathSchema, gitRefSchema } from '../../core/model/index.js';
import type { GitBranch, GitCommit, GitDiff, GitStatus } from '../../core/model/index.js';
import type { GitReader } from '../../core/ports.js';
import { runGit } from './exec.js';
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  STATUS_ARGS,
  parseBranches,
  parseCommits,
  parseStatus,
} from './parsers.js';

export interface GitReaderOptions {
  /** The repository to read; usually the board root. */
  root: string;
  gitBinary?: string | undefined;
  timeoutMs?: number | undefined;
  /** A longer diff is cut off; the client asks for a narrower path instead. */
  maxDiffChars?: number | undefined;
}

export const MAX_DIFF_CHARS = 512 * 1024;
const MAX_COMMITS = 200;

const NO_STATUS: GitStatus = { branch: null, detached: false, clean: true, files: [] };
const NO_DIFF: GitDiff = { text: '', truncated: false };

/**
 * Reads the repository through the system git binary (ADR-0007). Read-only, without a cache
 * and without watching `.git`. No git, an empty repository, a detached HEAD and a linked
 * worktree are answers, not exceptions (INVARIANT); nothing is invented for them.
 */
export function gitReader(options: GitReaderOptions): GitReader {
  const maxDiffChars = options.maxDiffChars ?? MAX_DIFF_CHARS;

  const exec = (args: string[]) =>
    runGit(args, {
      cwd: options.root,
      gitBinary: options.gitBinary,
      timeoutMs: options.timeoutMs,
    });

  async function available(): Promise<boolean> {
    const result = await exec(['rev-parse', '--is-inside-work-tree']);
    return result.ok && result.stdout.trim() === 'true';
  }

  return {
    available,

    async currentBranch() {
      // Works on an unborn branch too, where there is no commit to abbreviate.
      const head = await exec(['symbolic-ref', '--quiet', '--short', 'HEAD']);
      const name = head.stdout.trim();
      if (head.ok && name !== '') return { name, detached: false };
      // Without a branch it is either a detached HEAD or not a repository at all.
      return { name: null, detached: await available() };
    },

    async branches(): Promise<GitBranch[]> {
      const result = await exec(['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads']);
      return result.ok ? parseBranches(result.stdout) : [];
    },

    async status(): Promise<GitStatus> {
      const result = await exec(STATUS_ARGS);
      return result.ok ? parseStatus(result.stdout) : NO_STATUS;
    },

    async commits({ ref, limit }): Promise<GitCommit[]> {
      const count = Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_COMMITS);
      const result = await exec([
        '--no-pager',
        'log',
        `--pretty=format:${LOG_FORMAT}`,
        '-n',
        String(count),
        ...(ref === undefined ? [] : [requireRef(ref)]),
        '--',
      ]);
      return result.ok ? parseCommits(result.stdout) : [];
    },

    async diff({ ref, path, staged }): Promise<GitDiff> {
      const args = [
        '--no-pager',
        'diff',
        ...(staged === true ? ['--cached'] : []),
        ...(ref === undefined ? [] : [requireRef(ref)]),
        '--', // everything after this is a path, never an option
        ...(path === undefined ? [] : [requirePath(path)]),
      ];
      const result = await exec(args);
      if (!result.ok) return NO_DIFF;

      const tooLong = result.stdout.length > maxDiffChars;
      return {
        text: tooLong ? result.stdout.slice(0, maxDiffChars) : result.stdout,
        truncated: tooLong || result.truncated,
      };
    },
  };
}

/**
 * The HTTP layer validates refs and paths against the same schemas; the adapter checks again,
 * because it is the last place before the argument reaches git (§15).
 */
function requireRef(ref: string): string {
  return requireValid(gitRefSchema.safeParse(ref).success, 'ref', ref);
}

function requirePath(path: string): string {
  return requireValid(gitPathSchema.safeParse(path).success, 'path', path);
}

function requireValid(valid: boolean, argument: 'ref' | 'path', value: string): string {
  if (!valid) {
    throw new BoardError('INVALID_GIT_ARGUMENT', `Invalid git ${argument} "${value}".`, {
      argument,
      value,
    });
  }
  return value;
}
