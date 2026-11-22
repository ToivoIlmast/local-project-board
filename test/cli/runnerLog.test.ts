import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../../src/server/cli/run.js';
import { journalDir, writeJournal, type RunJournal } from '../../src/server/cli/runJournal.js';
import { logRunner, RUNNER_LOG } from '../../src/server/cli/runnerLog.js';
import { readRuntime, type RuntimeState } from '../../src/server/cli/runtime.js';
import { cli, cliInBackground, stopBoards } from '../support/cli.js';
import { fakeClaude } from '../support/fakeClaude.js';
import { freePort, releasePorts } from '../support/ports.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

/** The persistent runner log (T76 B2): argv of each session and the fate of each end. */

afterEach(async () => {
  await stopBoards();
  await releasePorts();
  await cleanTmpDirs();
});

const WAITING = /^Waiting for Send to AI → Claude Code/;

async function api(state: RuntimeState, method: string, path: string, body?: unknown) {
  return fetch(`${state.url}api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeout = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Line {
  at: string;
  event: string;
  taskId?: string;
  runId?: number;
  mode?: string;
  argv?: string[];
  delivery?: string;
  message?: string;
}

const SESSION = '3d0f71eb-97a5-476d-8ea4-e7b3eb0c5bfc';
const OTHER = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';

const journal = (extra: Partial<RunJournal> = {}): RunJournal => ({
  formatVersion: 1,
  taskId: 'T1',
  runId: 1,
  sessionId: SESSION,
  host: 'box',
  platform: 'linux',
  runner: { pid: 100 },
  ...extra,
});

/** A board with T1 whose run 1 works, as a runner that died leaves it. */
async function boardWithWorkingRun(): Promise<{ root: string; state: RuntimeState }> {
  const root = await tmpDir();
  await cli(['--port', String(await freePort()), '--no-open'], { cwd: root });
  const runtime = await readRuntime(root);
  if (runtime.kind !== 'state') throw new Error('unreachable');
  const state = runtime.state;
  expect((await api(state, 'POST', '/tasks', { title: 'Ship it' })).status).toBe(201);
  expect(
    (await api(state, 'POST', '/tasks/T1/ai-run', { sessionId: SESSION, mode: 'new' })).status,
  ).toBe(200);
  return { root, state };
}

const logPath = (root: string): string => join(journalDir(root), RUNNER_LOG);

async function readLog(root: string): Promise<Line[]> {
  const text = await readFile(logPath(root), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Line);
}

describe('runner log (T76 B2)', () => {
  it('records the exact argv of a new, a resumed and a restarted run, and each delivered end', async () => {
    const root = await tmpDir();
    const start = await cli(['--port', String(await freePort()), '--no-open'], { cwd: root });
    expect(start.exitCode).toBe(0);
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');
    const state = runtime.state;
    expect((await api(state, 'POST', '/tasks', { title: 'One', status: 'todo' })).status).toBe(201);
    const claude = await fakeClaude();
    const runner = cliInBackground(['claude', '--wait'], {
      cwd: root,
      env: claude.env({ exit: 1 }),
    });
    await runner.printed(WAITING);

    const send = (mode?: string) =>
      api(state, 'POST', '/tasks/T1/run', {
        agent: 'claude-code',
        ...(mode === undefined ? {} : { mode }),
      });
    expect((await send()).status).toBe(200);
    await until(
      () => readLog(root),
      (lines) => lines.filter((line) => line.event === 'end').length >= 1,
    );
    // The `end` line is logged before the runner waits again; a send in between answers 409.
    const sendWhenWaiting = async (mode: string): Promise<number> =>
      (
        await until(
          () => send(mode),
          (answer) => answer.status !== 409,
        )
      ).status;
    expect(await sendWhenWaiting('resume')).toBe(200);
    await until(
      () => readLog(root),
      (lines) => lines.filter((line) => line.event === 'end').length >= 2,
    );
    expect(await sendWhenWaiting('restart')).toBe(200);
    const lines = await until(
      () => readLog(root),
      (all) => all.filter((line) => line.event === 'end').length >= 3,
    );

    const calls = await claude.calls();
    const starts = lines.filter((line) => line.event === 'start');
    expect(starts.map((line) => line.mode)).toEqual(['new', 'resume', 'restart']);
    expect(starts.map((line) => line.argv)).toEqual(calls.map((call) => call.argv));
    expect(starts.map((line) => line.runId)).toEqual([1, 2, 3]);
    expect(lines.filter((line) => line.event === 'end').map((line) => line.delivery)).toEqual([
      'delivered',
      'delivered',
      'delivered',
    ]);
    const text = await readFile(logPath(root), 'utf8');
    expect(text).not.toContain(state.token);
    if (process.platform !== 'win32') {
      expect((await stat(logPath(root))).mode & 0o777).toBe(0o600);
    }
  });

  it('records an end the sweep delivers late, and one it drops for a replaced run', async () => {
    const { root, state } = await boardWithWorkingRun();
    // Run 1 of T1 is replaced by run 2; run 1 of T2 still works. Both ends wait in journals.
    expect(
      (
        await api(state, 'POST', '/tasks/T1/ai-run/1/abandon', {
          sessionId: SESSION,
          message: 'x',
        })
      ).status,
    ).toBe(200);
    expect(
      (await api(state, 'POST', '/tasks/T1/ai-run', { sessionId: SESSION, mode: 'resume' })).status,
    ).toBe(200);
    expect((await api(state, 'POST', '/tasks', { title: 'Two' })).status).toBe(201);
    expect(
      (await api(state, 'POST', '/tasks/T2/ai-run', { sessionId: OTHER, mode: 'new' })).status,
    ).toBe(200);
    const outcome = { exitCode: 2, endedAt: '2026-11-18T10:00:00.000Z' };
    await writeJournal(root, journal({ outcome }));
    await writeJournal(root, journal({ taskId: 'T2', sessionId: OTHER, outcome }));

    // `--recover` sweeps every journal before it looks at its own task.
    const result = await runCli(['claude', '--recover', 'T2'], {
      cwd: root,
      env: { XDG_CONFIG_HOME: '/board-test-no-user-config' },
      write: () => undefined,
      writeError: () => undefined,
    });
    expect(result.exitCode).toBe(0);

    const ends = (await readLog(root))
      .filter((line) => line.event === 'end')
      .map(({ taskId, runId, delivery }) => ({ taskId, runId, delivery }));
    expect(ends).toEqual(
      expect.arrayContaining([
        { taskId: 'T1', runId: 1, delivery: 'dropped' },
        { taskId: 'T2', runId: 1, delivery: 'delivered' },
      ]),
    );
    expect(ends).toHaveLength(2);
    expect(await readFile(logPath(root), 'utf8')).not.toContain(state.token);
  });

  it('records a pending end and the warning when the board is gone for good', async () => {
    const root = await tmpDir();
    const start = await cli(['--port', String(await freePort()), '--no-open'], { cwd: root });
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');
    const state = runtime.state;
    expect((await api(state, 'POST', '/tasks', { title: 'One', status: 'todo' })).status).toBe(201);
    const claude = await fakeClaude();
    const hold = join(await tmpDir(), 'release');
    const runner = cliInBackground(['claude', '--wait'], {
      cwd: root,
      env: claude.env({ holdUntil: hold, exit: 1 }),
    });
    let lines: Line[];
    try {
      await runner.printed(WAITING);
      expect((await api(state, 'POST', '/tasks/T1/run', { agent: 'claude-code' })).status).toBe(
        200,
      );
      await until(
        () => readLog(root),
        (all) => all.some((line) => line.event === 'start'),
      );

      // The board stops while Claude Code works; the runner retries the end for ~30 s, then
      // gives up.
      await start.stop?.();
      await writeFile(hold, '');
      lines = await until(
        () => readLog(root),
        (all) => all.some((line) => line.event === 'warning'),
        45_000,
      );
    } finally {
      // A held session left behind would keep the test run from ending.
      await writeFile(hold, '');
    }

    expect(
      lines
        .filter((line) => line.event === 'end')
        .map(({ runId, delivery }) => ({ runId, delivery })),
    ).toEqual([{ runId: 1, delivery: 'pending' }]);
    const warning = lines.find((line) => line.event === 'warning');
    expect(warning).toMatchObject({ taskId: 'T1', runId: 1 });
    expect(warning?.message).toMatch(/did not take the end of run 1 of T1/);
    expect(await readFile(logPath(root), 'utf8')).not.toContain(state.token);
  }, 60_000);

  it('never stops the run when the log cannot be written', async () => {
    const root = await tmpDir();
    // `.board` is a file: the directory of the log cannot be made.
    await writeFile(join(root, '.board'), 'not a directory');
    await expect(logRunner(root, { event: 'warning', message: 'x' })).resolves.toBeUndefined();
  });
});
