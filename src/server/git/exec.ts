import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GitExecOptions {
  /** Directory git runs in; the adapter never changes the process working directory. */
  cwd: string;
  gitBinary?: string | undefined;
  timeoutMs?: number | undefined;
  maxBuffer?: number | undefined;
}

export interface GitResult {
  /** git ran and exited with 0, or was cut off at maxBuffer with usable output. */
  ok: boolean;
  stdout: string;
  stderr: string;
  /** The output hit maxBuffer and is incomplete. */
  truncated: boolean;
}

export const GIT_TIMEOUT_MS = 10_000;
export const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Git is always spawned with `execFile` and an argument array: there is no shell, so no
 * value can ever become a command (ADR-0007, §15). Arguments are validated by the caller.
 */
export async function runGit(args: string[], options: GitExecOptions): Promise<GitResult> {
  const env = {
    ...process.env,
    // Reading must not take a lock in the user's repository, ask for credentials or page.
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
  };
  try {
    const { stdout, stderr } = await run(options.gitBinary ?? 'git', args, {
      cwd: options.cwd,
      env,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr, truncated: false };
  } catch (error) {
    // A missing binary, a non-zero exit, a timeout and too much output all land here.
    const failed = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const truncated = failed.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    return {
      ok: truncated,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
      truncated,
    };
  }
}
