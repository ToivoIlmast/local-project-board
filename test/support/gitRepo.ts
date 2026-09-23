import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Fixed identity and dates so recorded expectations stay stable. */
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_AUTHOR_DATE: '2026-09-21T09:00:00+00:00',
  GIT_COMMITTER_DATE: '2026-09-21T09:00:00+00:00',
};

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env, encoding: 'utf8' });
  return stdout;
}

/** An initialised repository without commits. */
export async function initRepo(dir: string): Promise<string> {
  await git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

export async function writeRepoFile(dir: string, name: string, content: string): Promise<void> {
  await writeFile(join(dir, name), content, 'utf8');
}

export async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', message);
}

/** A repository with one commit containing a.txt. */
export async function repoWithCommit(dir: string): Promise<string> {
  await initRepo(dir);
  await writeRepoFile(dir, 'a.txt', 'a\n');
  await commitAll(dir, 'first commit');
  return dir;
}
