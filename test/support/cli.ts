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

export interface BackgroundCli {
  /** What it printed so far; it keeps growing while the command runs. */
  out: string[];
  err: string[];
  /** Resolves when some line it printed matches, however long it has been running. */
  printed(pattern: RegExp, count?: number): Promise<void>;
  /** Asks it to stop, as Ctrl+C does, and resolves with how it ended. */
  stop(): Promise<CliRun>;
  /** How it ended, when it ends by itself. */
  done: Promise<CliRun>;
}

const background: (() => Promise<unknown>)[] = [];

/**
 * A command that runs until it is told to stop, like `claude --wait`: run in this process, so
 * a test can watch what it prints while it runs, and stop it the way the person would.
 */
export function cliInBackground(argv: string[], options: CliOptions): BackgroundCli {
  const out: string[] = [];
  const err: string[] = [];
  const controller = new AbortController();
  const done = runCli(argv, {
    cwd: options.cwd,
    env: { ...NO_USER_CONFIG, ...options.env },
    write: (line) => out.push(line),
    writeError: (line) => err.push(line),
    openBrowser: () => undefined,
    signal: controller.signal,
  }).then((result): CliRun => ({
    exitCode: result.exitCode,
    out,
    err,
    text: [...out, ...err].join('\n'),
    opened: [],
    stop: result.stop,
  }));
  const stop = async (): Promise<CliRun> => {
    controller.abort();
    return done;
  };
  background.push(stop);
  return {
    out,
    err,
    done,
    stop,
    async printed(pattern, count = 1) {
      const deadline = Date.now() + 10_000;
      const matches = (): number => [...out, ...err].filter((line) => pattern.test(line)).length;
      while (matches() < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `Never printed ${String(pattern)} x${count}:\n${[...out, ...err].join('\n')}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

/** Stops whatever a test left running, so a failed expectation cannot hang the suite. */
export async function stopBoards(): Promise<void> {
  for (const stop of background.splice(0)) await stop();
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
