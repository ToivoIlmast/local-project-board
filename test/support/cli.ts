import { spawn } from 'node:child_process';
import { runCli } from '../../src/server/cli/run.js';

export interface CliRun {
  exitCode: number;
  /** Lines written to stdout and to stderr, kept apart. */
  out: string[];
  err: string[];
  /** Everything the command printed, for leak assertions. */
  text: string;
  /** URLs the command asked a browser to open; the real browser is never spawned. */
  opened: string[];
  /** Set when the command left a server running. */
  stop?: (() => Promise<void>) | undefined;
}

export interface CliOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** No user-level config unless a test points at one: the developer's own must not leak in. */
const NO_USER_CONFIG = { XDG_CONFIG_HOME: '/board-test-no-user-config' };

const running: (() => Promise<void>)[] = [];

/** Runs the CLI the way `main.ts` does, but in this process so a test can look inside. */
export async function cli(argv: string[], options: CliOptions): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const result = await runCli(argv, {
    cwd: options.cwd,
    // An empty environment unless the test says otherwise: BOARD_* of the developer
    // running the suite must not reach the board under test.
    env: { ...NO_USER_CONFIG, ...options.env },
    write: (line) => out.push(line),
    writeError: (line) => err.push(line),
    openBrowser: (url) => opened.push(url),
  });
  if (result.stop) running.push(result.stop);
  return {
    exitCode: result.exitCode,
    out,
    err,
    text: [...out, ...err].join('\n'),
    opened,
    stop: result.stop,
  };
}

/** Stops whatever a test left running, so a failed expectation cannot hang the suite. */
export async function stopBoards(): Promise<void> {
  for (const stop of running.splice(0)) await stop();
}

/** A pid that is certainly not a running process: a child that has already exited. */
export function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '']);
    child.on('error', reject);
    child.on('exit', () => resolve(child.pid ?? 999_999));
  });
}
