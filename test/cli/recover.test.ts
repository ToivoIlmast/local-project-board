import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../../src/server/cli/run.js';
import { procProbe, type ProcessProbe } from '../../src/server/cli/processProbe.js';
import { readRuntime, type RuntimeState } from '../../src/server/cli/runtime.js';
import { journalDir, writeJournal, type RunJournal } from '../../src/server/cli/runJournal.js';
import { cli, cliInBackground, stopBoards } from '../support/cli.js';
import { fakeClaude } from '../support/fakeClaude.js';
import { freePort, releasePorts } from '../support/ports.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

/**
 * `local-project-board claude --recover <ID>` (T45): the person's own command, in a terminal of
 * the project, that looks at this machine and tells the board a run is lost only on proof.
 */

afterEach(async () => {
  await stopBoards();
  await releasePorts();
  await cleanTmpDirs();
});

const SESSION = '3d0f71eb-97a5-476d-8ea4-e7b3eb0c5bfc';

async function api(state: RuntimeState, method: string, path: string, body?: unknown) {
  return fetch(`${state.url}api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function aiRun(state: RuntimeState): Promise<Record<string, unknown> | undefined> {
  const task = (await (await api(state, 'GET', '/tasks/T1')).json()) as {
    aiRun?: Record<string, unknown>;
  };
  return task.aiRun;
}

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

function machine(overrides: Partial<ProcessProbe> = {}): ProcessProbe {
  return {
    platform: 'linux',
    ownPid: 1,
    hostname: () => 'box',
    bootId: () => Promise.resolve('boot-1'),
    pidNamespace: () => Promise.resolve('pid:[1]'),
    startOf: () => Promise.resolve('gone'),
    processes: () => Promise.resolve({ list: [], unreadable: 0 }),
    ...overrides,
  };
}

const journal = (extra: Partial<RunJournal> = {}): RunJournal => ({
  formatVersion: 1,
  taskId: 'T1',
  runId: 1,
  sessionId: SESSION,
  host: 'box',
  platform: 'linux',
  bootId: 'boot-1',
  pidNamespace: 'pid:[1]',
  runner: { pid: 100, start: '5000' },
  child: { pid: 101, start: '5001' },
  ...extra,
});

async function recover(root: string, probe: ProcessProbe, ...flags: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const result = await runCli(['claude', '--recover', 'T1', ...flags], {
    cwd: root,
    env: { XDG_CONFIG_HOME: '/board-test-no-user-config' },
    write: (line) => out.push(line),
    writeError: (line) => err.push(line),
    processProbe: probe,
  });
  return { exitCode: result.exitCode, text: [...out, ...err].join('\n') };
}

describe('claude --recover <ID> (T45)', () => {
  it('a live process: refuses, and the board is not changed (INVARIANT)', async () => {
    const { root, state } = await boardWithWorkingRun();
    await writeJournal(root, journal());
    const before = await aiRun(state);

    const result = await recover(
      root,
      machine({ startOf: (pid) => Promise.resolve(pid === 101 ? '5001' : 'gone') }),
      '--confirm-stopped',
    );

    expect(result.exitCode).toBe(1);
    expect(result.text).toMatch(/alive/);
    // Even an explicit confirmation does not override a process that is seen running.
    expect(await aiRun(state)).toEqual(before);
  });

  it('a lost run: failed{lost} with the evidence, runId and sessionId kept, the journal gone (INVARIANT)', async () => {
    const { root, state } = await boardWithWorkingRun();
    await writeJournal(root, journal());

    const result = await recover(root, machine());

    expect(result.exitCode).toBe(0);
    expect(result.text).toMatch(/lost/);
    const run = await aiRun(state);
    expect(run).toMatchObject({ state: 'failed', runId: 1, sessionId: SESSION });
    expect(run?.failure).toMatchObject({ kind: 'lost', message: expect.stringMatching(/101/) });
    expect(await readdir(journalDir(root)).catch(() => [])).toEqual([]);
  });

  it('unknown without --confirm-stopped: nothing changes, and it says how to confirm (INVARIANT)', async () => {
    // No journal: this run was not started by a runner that keeps one, as for T37.
    const { root, state } = await boardWithWorkingRun();
    const before = await aiRun(state);

    const result = await recover(root, machine());

    expect(result.exitCode).toBe(1);
    expect(result.text).toMatch(/unknown/);
    expect(result.text).toContain('--confirm-stopped');
    expect(await aiRun(state)).toEqual(before);
  });

  it('unknown with --confirm-stopped: failed{lost}, and the message says the person confirmed it', async () => {
    const { root, state } = await boardWithWorkingRun();

    const result = await recover(root, machine({ platform: 'darwin' }), '--confirm-stopped');

    expect(result.exitCode).toBe(0);
    const run = await aiRun(state);
    expect(run).toMatchObject({ state: 'failed', runId: 1, sessionId: SESSION });
    const message = (run?.failure as { message: string }).message;
    expect(message).toMatch(/confirmed/i);
    expect(message).toMatch(/darwin/);
  });

  it('a run that is not working: nothing to recover, nothing written', async () => {
    const { root, state } = await boardWithWorkingRun();
    await api(state, 'POST', '/tasks/T1/ai-run/1/end', { exitCode: 1, sessionId: SESSION });
    const before = await aiRun(state);

    const result = await recover(root, machine(), '--confirm-stopped');

    expect(result.exitCode).toBe(0);
    expect(result.text).toMatch(/nothing to recover/i);
    expect(await aiRun(state)).toEqual(before);
  });

  it('an end the runner recorded but could not deliver is delivered, not replaced by lost (INVARIANT)', async () => {
    const { root, state } = await boardWithWorkingRun();
    await writeJournal(
      root,
      journal({ outcome: { exitCode: 3, endedAt: '2026-10-11T10:00:00.000Z' } }),
    );

    const result = await recover(root, machine());

    expect(result.exitCode).toBe(0);
    expect(await aiRun(state)).toMatchObject({
      state: 'failed',
      failure: { kind: 'exit', exitCode: 3 },
      endedAt: '2026-10-11T10:00:00.000Z',
    });
    expect(await readdir(journalDir(root)).catch(() => [])).toEqual([]);
  });

  it('prints no token', async () => {
    const { root, state } = await boardWithWorkingRun();
    await writeJournal(root, journal());
    const result = await recover(root, machine());
    expect(result.text).not.toContain(state.token);
  });
});

describe('the runner journal (T45)', () => {
  it('a pending end is delivered by the next claude --wait, after a restart of the board (INVARIANT)', async () => {
    const { root, state } = await boardWithWorkingRun();
    await writeJournal(
      root,
      journal({ outcome: { exitCode: 2, endedAt: '2026-10-11T10:00:00.000Z' } }),
    );
    const claude = await fakeClaude();

    const waiting = cliInBackground(['claude', '--wait'], { cwd: root, env: claude.env() });
    await waiting.printed(/Waiting for Send to AI/);

    const deadline = Date.now() + 5000;
    while ((await aiRun(state))?.state === 'working' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await aiRun(state)).toMatchObject({ state: 'failed', failure: { exitCode: 2 } });
    expect(await readdir(journalDir(root)).catch(() => [])).toEqual([]);
    await waiting.stop();
  });

  it('a pending end of a run the board has replaced is dropped, and the new run is untouched (INVARIANT)', async () => {
    const { root, state } = await boardWithWorkingRun();
    await api(state, 'POST', '/tasks/T1/ai-run/1/abandon', { sessionId: SESSION, message: 'x' });
    await api(state, 'POST', '/tasks/T1/ai-run', { sessionId: SESSION, mode: 'resume' });
    const current = await aiRun(state);
    await writeJournal(
      root,
      journal({ outcome: { exitCode: 0, endedAt: '2026-10-11T10:00:00.000Z' } }),
    );

    await recover(root, machine());

    expect(await aiRun(state)).toEqual(current);
    expect(await readdir(journalDir(root)).catch(() => [])).toEqual([]);
  });

  it('a session started by the runner leaves a journal with its process and no token, readable by its owner only', async () => {
    const root = await tmpDir();
    await cli(['--port', String(await freePort()), '--no-open'], { cwd: root });
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');
    await api(runtime.state, 'POST', '/tasks', { title: 'Ship it' });
    const claude = await fakeClaude();
    const hold = join(await tmpDir(), 'release');

    const session = cliInBackground(['claude', 'T1'], {
      cwd: root,
      env: claude.env({ holdUntil: hold }),
    });
    try {
      const deadline = Date.now() + 10_000;
      let record: RunJournal | undefined;
      while (Date.now() < deadline) {
        const files = await readdir(journalDir(root)).catch(() => [] as string[]);
        if (files.length === 1) {
          const parsed = JSON.parse(
            await readFile(join(journalDir(root), files[0]!), 'utf8'),
          ) as RunJournal;
          if (parsed.child !== undefined) {
            record = parsed;
            const text = await readFile(join(journalDir(root), files[0]!), 'utf8');
            expect(text).not.toContain(runtime.state.token);
            expect((await stat(join(journalDir(root), files[0]!))).mode & 0o077).toBe(0);
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(record).toMatchObject({ taskId: 'T1', runId: 1, runner: { pid: process.pid } });
      // The stand-in writes down its pid a moment after it was spawned.
      let calls = await claude.calls();
      while (calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        calls = await claude.calls();
      }
      expect(record?.child?.pid).toBe(calls[0]?.pid);
      expect(record?.sessionId).toBe(calls[0]?.argv[1]);
    } finally {
      // Released whatever happened, or the session would outlive the test.
      await writeFile(hold, '');
    }
    await session.done;
    // Delivered: nothing is left to deliver.
    expect(await readdir(journalDir(root)).catch(() => [])).toEqual([]);
  });
});

describe('procProbe on this machine (T45)', () => {
  const probe = procProbe();
  const linux = process.platform === 'linux';

  (linux ? it : it.skip)('sees this process, with a start time that does not change', async () => {
    const first = await probe.startOf(process.pid);
    expect(first).toMatch(/^\d+$/);
    expect(await probe.startOf(process.pid)).toBe(first);
    expect(await probe.bootId()).toMatch(/\S/);
    expect(await probe.pidNamespace()).toMatch(/^pid:\[\d+\]$/);
    const { list } = await probe.processes();
    expect(list.find((entry) => entry.pid === process.pid)?.argv.length).toBeGreaterThan(0);
  });

  (linux ? it : it.skip)('says a pid that does not exist is gone', async () => {
    expect(await probe.startOf(2 ** 22 + 12345)).toBe('gone');
  });
});
