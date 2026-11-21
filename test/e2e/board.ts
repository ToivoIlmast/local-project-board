import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test as base } from '@playwright/test';

const repository = fileURLToPath(new URL('../..', import.meta.url));

export interface RunningBoard {
  url: string;
  root: string;
  /** Everything the board printed, so a test can prove what it did not print. */
  output(): string;
  /** Change the board the way an agent would: through the API, with this run's token. */
  api(path: string, init?: { method?: string; body?: unknown }): Promise<unknown>;
  /**
   * Wait for Send to AI as `claude --wait` does, starting nothing: resolves with the one request
   * the board hands to a waiting runner, one of the current version (it accepts a check and a
   * research, as the real runner says). A runner is waiting once this has been called.
   */
  waitForRun(): Promise<{ request: Promise<unknown> }>;
  /** Stop the process the way Ctrl+C does, leaving the project directory as it is. */
  stop(): Promise<void>;
  /** Start it again in the same directory and on the same port, with a new session token. */
  restart(): Promise<void>;
  /**
   * Start `local-project-board <args>` in the project, as a person does in a terminal of it
   * (`claude --wait`, `claude T1`). `env` is added to the environment of the test. The board owns
   * the process: it is stopped, with whatever `claude` it started, before the project is removed.
   */
  spawnRunner(args: string[], env?: NodeJS.ProcessEnv): Runner;
}

export interface Runner {
  child: ChildProcess;
  /** Everything it printed so far. */
  printed(): string;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Signals the whole process group of a runner; a group that is already empty is no error. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * Stops a runner as a person would, then as the system would, keeping what the runner does on
 * each: Ctrl+C ends a wait but not a session, SIGTERM ends a session (the runner passes it to
 * `claude` and records the end), SIGKILL ends whatever is left. Resolves once its process
 * group is empty — the runner and every `claude` it started, also one it left behind when it
 * was killed — and rejects if anything outlives SIGKILL.
 */
async function stopRunner(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const exited = new Promise<true>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(true);
    else child.once('exit', () => resolve(true));
  });
  const within = (ms: number): Promise<boolean> =>
    Promise.race([exited, delay(ms).then(() => false)]);

  for (const [signal, ms] of [
    ['SIGINT', 2_000],
    ['SIGTERM', 5_000],
  ] as const) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    child.kill(signal);
    if (await within(ms)) break;
  }

  signalGroup(pid, 'SIGKILL');
  for (let waited = 0; signalGroup(pid, 0); waited += 50) {
    if (waited >= 5_000) throw new Error(`Process group ${pid} outlived SIGKILL.`);
    await delay(50);
  }
  await exited;
}

/** A board started exactly the way a user starts one: `npx local-project-board`. */
export async function startBoard(): Promise<{
  board: RunningBoard;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'board-e2e-'));
  /** Everything every run of the board printed, in order. */
  let output = '';
  let running: ChildProcess | undefined;
  let url = '';
  let token = '';
  const runners: ChildProcess[] = [];

  const spawnBoard = async (port?: number): Promise<void> => {
    const child = spawn(
      process.execPath,
      [
        join(repository, 'bin/board.js'),
        '--no-open',
        ...(port === undefined ? [] : ['--port', String(port)]),
      ],
      {
        cwd: root,
        // The developer's own configuration must not reach the board under test.
        env: { ...process.env, XDG_CONFIG_HOME: join(root, 'no-user-config') },
      },
    );
    running = child;

    // This run's own output, so a restart does not read the previous run's address.
    let printed = '';
    const collect = (chunk: Buffer): void => {
      printed += chunk.toString();
      output += chunk.toString();
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`The board did not start:\n${printed}`)),
        30_000,
      );
      const look = (): void => {
        const match = /running at (http:\/\/\S+)/.exec(printed);
        if (!match?.[1]) return;
        clearTimeout(timer);
        resolve(match[1]);
      };
      child.stdout?.on('data', look);
      child.on('exit', () => reject(new Error(`The board stopped:\n${printed}`)));
    });

    // A restart mints a new token, so it is read again and not remembered from before.
    const runtime = JSON.parse(await readFile(join(root, '.board', 'runtime.json'), 'utf8')) as {
      token: string;
    };
    token = runtime.token;
  };

  const stop = async (): Promise<void> => {
    const child = running;
    if (!child) return;
    running = undefined;
    child.kill('SIGTERM');
    await new Promise((exited) => child.on('exit', exited));
  };

  await spawnBoard();

  const board: RunningBoard = {
    get url() {
      return url;
    },
    root,
    output: () => output,
    stop,
    async restart() {
      await stop();
      await spawnBoard(Number(new URL(url).port));
    },
    spawnRunner(args, env = {}) {
      const child = spawn(process.execPath, [join(repository, 'bin/board.js'), ...args], {
        cwd: root,
        env: { ...process.env, ...env, XDG_CONFIG_HOME: join(root, 'no-user-config') },
        // A process group of its own, which the `claude` it starts joins: stopping the group
        // stops a `claude` the runner left behind too.
        detached: true,
      });
      runners.push(child);
      let printed = '';
      child.stdout?.on('data', (chunk: Buffer) => (printed += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (printed += chunk.toString()));
      return { child, printed: () => printed };
    },
    async waitForRun() {
      const response = await fetch(`${url.replace(/\/$/, '')}/api/v1/runs?accepts=check,research`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      });
      if (!response.ok) throw new Error(`/api/v1/runs answered ${response.status}`);
      // The board sends one request and ends the stream.
      // Wrapped: an async function would otherwise wait for the run itself before resolving.
      const request = response.text().then((text) => {
        const data = /^data: (.*)$/m.exec(text)?.[1];
        if (data === undefined) throw new Error(`No run was handed over:\n${text}`);
        return JSON.parse(data) as unknown;
      });
      return { request };
    },
    async api(path, init = {}) {
      const response = await fetch(`${url.replace(/\/$/, '')}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      if (!response.ok) throw new Error(`${path} answered ${response.status}`);
      return response.json();
    },
  };

  const dispose = async (): Promise<void> => {
    // Runners first, while the board is still there to hear how their sessions ended.
    const stopped = await Promise.allSettled(runners.splice(0).map(stopRunner));
    await stop();
    const failures = stopped.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    // A process still writing into the project would write it back once it is removed.
    if (failures.length > 0) {
      throw new AggregateError(failures, `Runners outlived SIGKILL; ${root} is left in place.`);
    }
    await rm(root, { recursive: true, force: true });
  };

  return { board, dispose };
}

export const test = base.extend<{ board: RunningBoard }>({
  // Playwright reads the destructuring to know which fixtures are wanted; this one wants none.
  // eslint-disable-next-line no-empty-pattern
  board: async ({}, use) => {
    const { board, dispose } = await startBoard();
    await use(board);
    await dispose();
  },
});

export { expect } from '@playwright/test';
