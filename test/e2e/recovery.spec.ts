import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type RunningBoard } from './board';

/**
 * A runner that dies (T45), with real processes: the runner is killed with SIGKILL, as a closed
 * terminal or a crash would kill it, and nothing in it gets to say goodbye. What it wrote to
 * its journal before is all that is left, and the board is only changed on proof.
 */

const CLI = fileURLToPath(new URL('../../bin/board.js', import.meta.url));
const linux = process.platform === 'linux';

interface AiRun {
  state: string;
  runId: number;
  sessionId: string;
  mode?: string;
  failure?: { kind: string; message: string; exitCode?: number };
}

/** A `claude` that writes down who it is, stays until it is released, and exits with 3. */
async function fakeClaude(root: string): Promise<{ bin: string; log: string; release: string }> {
  const bin = join(root, 'fake-bin');
  await mkdir(bin);
  const log = join(root, 'claude-calls.jsonl');
  const release = join(root, 'release-claude');
  await writeFile(
    join(bin, 'claude'),
    [
      `#!${process.execPath}`,
      "const { appendFileSync, existsSync } = require('node:fs');",
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + '\\n');`,
      `const wait = () => existsSync(${JSON.stringify(release)}) ? process.exit(3) : setTimeout(wait, 50);`,
      'wait();',
      '',
    ].join('\n'),
  );
  await chmod(join(bin, 'claude'), 0o755);
  return { bin, log, release };
}

const env = (root: string, bin: string): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: `${bin}:${process.env['PATH'] ?? ''}`,
  XDG_CONFIG_HOME: join(root, 'no-user-config'),
});

function cli(root: string, bin: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: root, env: env(root, bin) },
      (error, out, err) =>
        resolve({ code: error === null ? 0 : Number(error.code ?? 1), output: `${out}${err}` }),
    );
  });
}

function startRunner(root: string, bin: string, args: string[]): ChildProcess {
  return spawn(process.execPath, [CLI, ...args], { cwd: root, env: env(root, bin) });
}

async function calls(log: string): Promise<{ pid: number; argv: string[] }[]> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { pid: number; argv: string[] });
}

const journalFile = (root: string, task: string, runId: number): string =>
  join(root, '.board', 'runner', `${task}-${runId}.json`);

async function journal(
  root: string,
  task: string,
  runId: number,
): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(journalFile(root, task, runId), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

/** A process is gone when /proc has no live entry for it (a zombie is not alive). */
async function gone(pid: number): Promise<boolean> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
  if (stat === undefined) return true;
  return /^[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 2));
}

const aiRun = async (board: RunningBoard): Promise<AiRun> =>
  ((await board.api('/api/v1/tasks/T1')) as { aiRun: AiRun }).aiRun;

function killed(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

test.skip(!linux, 'recovery reads /proc, which only Linux has');

test('a runner killed mid-session: --recover sees claude alive, then lost once it ends; Resume continues the session as run 2 (T45)', async ({
  board,
}) => {
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'Ship it', status: 'todo' } });
  const claude = await fakeClaude(board.root);

  const runner = startRunner(board.root, claude.bin, ['claude', 'T1']);
  await expect.poll(async () => (await journal(board.root, 'T1', 1))?.['child']).toBeDefined();
  const [call] = await calls(claude.log);
  const sessionId = (await aiRun(board)).sessionId;
  expect(call?.argv.slice(0, 2)).toEqual(['--session-id', sessionId]);

  // The runner dies without a word; claude goes on, an orphan.
  await killed(runner);
  expect((await aiRun(board)).state).toBe('working');

  // Alive: refused, even when the person says it stopped.
  const alive = await cli(board.root, claude.bin, [
    'claude',
    '--recover',
    'T1',
    '--confirm-stopped',
  ]);
  expect(alive.code).toBe(1);
  expect(alive.output).toMatch(/: alive — /);
  expect(alive.output).toContain(`process ${call?.pid} holds session ${sessionId}`);
  expect(await aiRun(board)).toMatchObject({ state: 'working', runId: 1 });

  // claude ends; nobody is left to tell the board.
  await writeFile(claude.release, '');
  await expect.poll(() => gone(call?.pid ?? 0)).toBe(true);
  expect((await aiRun(board)).state).toBe('working');

  // Lost, on proof: no confirmation is needed.
  const lost = await cli(board.root, claude.bin, ['claude', '--recover', 'T1']);
  expect(lost.code).toBe(0);
  const abandoned = await aiRun(board);
  expect(abandoned).toMatchObject({
    state: 'failed',
    runId: 1,
    sessionId,
    failure: { kind: 'lost' },
  });
  expect(abandoned.failure?.message).toContain(`claude (pid ${call?.pid})`);
  expect(await journal(board.root, 'T1', 1)).toBeUndefined();

  // Resume through Send to AI and a runner: the same session, as run 2.
  const waiting = startRunner(board.root, claude.bin, ['claude', '--wait']);
  try {
    let printed = '';
    waiting.stdout?.on('data', (chunk: Buffer) => (printed += chunk.toString()));
    await expect.poll(() => printed, { timeout: 15_000 }).toContain('Waiting for Send to AI');
    await board.api('/api/v1/tasks/T1/run', {
      method: 'POST',
      body: { agent: 'claude-code', mode: 'resume' },
    });
    // Run 1 is already failed (lost): wait for run 2 to be over.
    await expect
      .poll(
        async () => {
          const run = await aiRun(board);
          return run.runId === 2 && run.state !== 'working';
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    expect(await aiRun(board)).toMatchObject({
      runId: 2,
      sessionId,
      mode: 'resume',
      failure: { kind: 'exit', exitCode: 3 },
    });
    expect((await calls(claude.log)).at(-1)?.argv).toEqual(
      expect.arrayContaining(['--resume', sessionId]),
    );
  } finally {
    await killed(waiting);
  }
});

test('an end the runner could not deliver survives the runner and a restart of the board (T45)', async ({
  board,
}) => {
  await board.api('/api/v1/tasks', { method: 'POST', body: { title: 'Ship it', status: 'todo' } });
  const claude = await fakeClaude(board.root);

  const runner = startRunner(board.root, claude.bin, ['claude', 'T1']);
  await expect.poll(async () => (await journal(board.root, 'T1', 1))?.['child']).toBeDefined();

  // The board goes away; claude ends; the runner records the end and retries in vain …
  await board.stop();
  await writeFile(claude.release, '');
  await expect
    .poll(async () => (await journal(board.root, 'T1', 1))?.['outcome'], { timeout: 15_000 })
    .toMatchObject({ exitCode: 3 });
  // … and dies before the board is back.
  await killed(runner);

  await board.restart();
  expect((await aiRun(board)).state).toBe('working');
  const runtime = JSON.parse(
    await readFile(join(board.root, '.board', 'runtime.json'), 'utf8'),
  ) as { token: string };
  expect(await readFile(journalFile(board.root, 'T1', 1), 'utf8')).not.toContain(runtime.token);

  // The next runner delivers it: the real end, not lost.
  const next = startRunner(board.root, claude.bin, ['claude', '--wait']);
  try {
    await expect
      .poll(async () => (await aiRun(board)).failure, { timeout: 15_000 })
      .toMatchObject({ kind: 'exit', exitCode: 3 });
    expect(await aiRun(board)).toMatchObject({ state: 'failed', runId: 1 });
    await expect.poll(() => journal(board.root, 'T1', 1)).toBeUndefined();
  } finally {
    await killed(next);
  }
});
