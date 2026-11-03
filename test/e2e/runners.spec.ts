import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, startBoard, test, type RunningBoard, type Runner } from './board';

/**
 * The fixture, not the runner: every runner a test starts through the board is gone, with the
 * `claude` it started, before the project is removed, and nothing writes the project back
 * afterwards. A runner keeps its session through Ctrl+C on purpose, so a test that only sends
 * SIGINT and moves on leaves it writing its journal into a directory being removed.
 */

const linux = process.platform === 'linux';

/**
 * A `claude` that writes its pid down and stays until it is released. `stubborn` also ignores
 * SIGINT and SIGTERM, so its runner, which waits for it, does not end either.
 */
async function fakeClaude(
  root: string,
  stubborn = false,
): Promise<{ env: NodeJS.ProcessEnv; pids: () => Promise<number[]>; release: string }> {
  const bin = join(root, stubborn ? 'stubborn-bin' : 'fake-bin');
  await mkdir(bin);
  const log = join(root, stubborn ? 'stubborn-pids' : 'claude-pids');
  const release = join(root, 'release-claude');
  await writeFile(
    join(bin, 'claude'),
    [
      `#!${process.execPath}`,
      "const { appendFileSync, existsSync } = require('node:fs');",
      ...(stubborn ? ["process.on('SIGINT', () => {});", "process.on('SIGTERM', () => {});"] : []),
      `appendFileSync(${JSON.stringify(log)}, process.pid + '\\n');`,
      `const wait = () => existsSync(${JSON.stringify(release)}) ? process.exit(0) : setTimeout(wait, 50);`,
      'wait();',
      '',
    ].join('\n'),
  );
  await chmod(join(bin, 'claude'), 0o755);
  const pids = async (): Promise<number[]> =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter((line) => line !== '')
      .map(Number);
  return { env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` }, pids, release };
}

/** A process is gone when /proc has no live entry for it (a zombie is not alive). */
async function gone(pid: number): Promise<boolean> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
  if (stat === undefined) return true;
  return /^[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 2));
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const waiting = async (runner: Runner): Promise<void> =>
  expect.poll(() => runner.printed(), { timeout: 15_000 }).toContain('Waiting for Send to AI');

/** A session of T1 started from the board, as Send to AI does, by a runner already waiting. */
async function sendToAi(board: RunningBoard, pids: () => Promise<number[]>): Promise<number> {
  await board.api('/api/v1/tasks/T1/run', { method: 'POST', body: { agent: 'claude-code' } });
  await expect.poll(async () => (await pids()).length, { timeout: 15_000 }).toBe(1);
  const [pid] = await pids();
  return pid ?? 0;
}

/** Removed, and not written back by anything that was still running. */
async function removedForGood(root: string): Promise<void> {
  expect(await exists(root)).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(await exists(root)).toBe(false);
}

test.skip(!linux, 'reads /proc, which only Linux has');

test('a runner between sessions stops on Ctrl+C before the project is removed', async () => {
  const { board, dispose } = await startBoard();
  const claude = await fakeClaude(board.root);
  const runner = board.spawnRunner(['claude', '--wait'], claude.env);
  await waiting(runner);

  await dispose();

  // Stopped the way a person stops it, not killed.
  expect(runner.child.exitCode).toBe(0);
  await removedForGood(board.root);
});

test('a runner in a session is stopped with its claude, and its journal is written before the project is removed', async () => {
  const { board, dispose } = await startBoard();
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'Ship it', status: 'todo' } });
  const claude = await fakeClaude(board.root);
  const runner = board.spawnRunner(['claude', '--wait'], claude.env);
  await waiting(runner);
  const pid = await sendToAi(board, claude.pids);

  await dispose();

  // Ctrl+C belongs to the session; the runner ended it on SIGTERM, as it does, and exited.
  expect(runner.child.exitCode).toBe(0);
  expect(await gone(pid)).toBe(true);
  await removedForGood(board.root);
});

test('a runner that ignores every polite signal is killed, with its claude, before the project is removed', async () => {
  const { board, dispose } = await startBoard();
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'Ship it', status: 'todo' } });
  const claude = await fakeClaude(board.root, true);
  const runner = board.spawnRunner(['claude', '--wait'], claude.env);
  await waiting(runner);
  const pid = await sendToAi(board, claude.pids);

  await dispose();

  expect(runner.child.signalCode).toBe('SIGKILL');
  expect(await gone(pid)).toBe(true);
  await removedForGood(board.root);
});

test('several runners, one already dead with its claude left behind: all are gone before the project is removed', async () => {
  const { board, dispose } = await startBoard();
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'Ship it', status: 'todo' } });
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'And this', status: 'todo' } });
  const claude = await fakeClaude(board.root);
  const stubborn = await fakeClaude(board.root, true);

  const waiter = board.spawnRunner(['claude', '--wait'], claude.env);
  const working = board.spawnRunner(['claude', 'T1'], claude.env);
  const dead = board.spawnRunner(['claude', 'T2'], stubborn.env);
  await waiting(waiter);
  await expect.poll(async () => (await claude.pids()).length, { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => (await stubborn.pids()).length, { timeout: 15_000 }).toBe(1);
  const pids = [...(await claude.pids()), ...(await stubborn.pids())];

  // A runner that died as a closed terminal kills it: its claude goes on, an orphan.
  await new Promise((exited) => {
    dead.child.once('exit', exited);
    dead.child.kill('SIGKILL');
  });

  await dispose();

  for (const runner of [waiter, working, dead]) {
    expect(runner.child.exitCode !== null || runner.child.signalCode !== null).toBe(true);
  }
  for (const pid of pids) expect(await gone(pid)).toBe(true);
  await removedForGood(board.root);
});
