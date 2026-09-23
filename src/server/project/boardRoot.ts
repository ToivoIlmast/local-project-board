import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runGit } from '../git/exec.js';

export interface BoardRootOptions {
  gitBinary?: string | undefined;
}

/**
 * The board lives next to the git common directory, so every linked worktree of a repository
 * opens the same `.board/` (ADR-0001). Outside a repository the board root is the directory
 * itself.
 */
export async function resolveBoardRoot(
  cwd: string,
  options: BoardRootOptions = {},
): Promise<string> {
  const result = await runGit(['rev-parse', '--git-common-dir'], {
    cwd,
    gitBinary: options.gitBinary,
  });
  const commonDir = result.stdout.trim();
  // git answers relatively to cwd in the main worktree and absolutely in a linked one.
  const root = result.ok && commonDir !== '' ? dirname(resolve(cwd, commonDir)) : cwd;
  return canonical(root);
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}
