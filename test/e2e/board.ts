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
}

/** A board started exactly the way a user starts one: `npx local-project-board`. */
async function startBoard(): Promise<{ board: RunningBoard; stop: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'board-e2e-'));
  const child: ChildProcess = spawn(
    process.execPath,
    [join(repository, 'bin/board.js'), '--no-open'],
    {
      cwd: root,
      // The developer's own configuration must not reach the board under test.
      env: { ...process.env, XDG_CONFIG_HOME: join(root, 'no-user-config') },
    },
  );

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The board did not start:\n${output}`)),
      30_000,
    );
    const look = (): void => {
      const match = /running at (http:\/\/\S+)/.exec(output);
      if (!match?.[1]) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    child.stdout?.on('data', look);
    child.on('exit', () => reject(new Error(`The board stopped:\n${output}`)));
  });

  const runtime = JSON.parse(await readFile(join(root, '.board', 'runtime.json'), 'utf8')) as {
    token: string;
  };

  const board: RunningBoard = {
    url,
    root,
    output: () => output,
    async api(path, init = {}) {
      const response = await fetch(`${url.replace(/\/$/, '')}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${runtime.token}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      if (!response.ok) throw new Error(`${path} answered ${response.status}`);
      return response.json();
    },
  };

  const stop = async (): Promise<void> => {
    child.kill('SIGTERM');
    await new Promise((done) => child.on('exit', done));
    await rm(root, { recursive: true, force: true });
  };

  return { board, stop };
}

export const test = base.extend<{ board: RunningBoard }>({
  // Playwright reads the destructuring to know which fixtures are wanted; this one wants none.
  // eslint-disable-next-line no-empty-pattern
  board: async ({}, use) => {
    const { board, stop } = await startBoard();
    await use(board);
    await stop();
  },
});

export { expect } from '@playwright/test';
