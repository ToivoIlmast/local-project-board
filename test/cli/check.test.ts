import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeCheckPrompt } from '../../src/contract/v1/index.js';
import { deliverPendingCheckEnds } from '../../src/server/cli/checkEnd.js';
import {
  checkJournalSchema,
  listCheckJournals,
  writeCheckJournal,
  type CheckJournal,
} from '../../src/server/cli/checkJournal.js';
import { deliverPendingEnds } from '../../src/server/cli/runEnd.js';
import {
  journalDir,
  listJournals,
  readJournal,
  writeJournal,
  type RunJournal,
} from '../../src/server/cli/runJournal.js';
import { readRuntime, type RuntimeState } from '../../src/server/cli/runtime.js';
import { cli, cliInBackground, stopBoards } from '../support/cli.js';
import { fakeClaude } from '../support/fakeClaude.js';
import { freePort, releasePorts } from '../support/ports.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

/**
 * `local-project-board claude <ID> --check` and the runner that handles `kind: 'check'` (T46,
 * ADR-0030 §6): the same way of starting Claude Code as a run, recorded apart from `aiRun`, with
 * a journal of its own that the journals and the recovery of work runs never see.
 */

afterEach(async () => {
  await stopBoards();
  await releasePorts();
  await cleanTmpDirs();
});

const SESSION = '3d0f71eb-97a5-476d-8ea4-e7b3eb0c5bfc';
const WAITING = /^Waiting for Send to AI → Claude Code/;

async function api(state: RuntimeState, method: string, path: string, body?: unknown) {
  return fetch(`${state.url}api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const json = async <T>(answer: Response): Promise<T> => (await answer.json()) as T;

async function board(): Promise<{ root: string; state: RuntimeState }> {
  const root = await tmpDir();
  const start = await cli(['--port', String(await freePort()), '--no-open'], { cwd: root });
  expect(start.exitCode).toBe(0);
  const runtime = await readRuntime(root);
  if (runtime.kind !== 'state') throw new Error('unreachable');
  for (const title of ['Extract the git adapter', 'Write the report']) {
    expect((await api(runtime.state, 'POST', '/tasks', { title, status: 'todo' })).status).toBe(
      201,
    );
  }
  return { root, state: runtime.state };
}

const boardUrl = (state: RuntimeState): string => state.url.replace(/\/$/, '');

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const checkOf = (state: RuntimeState, id: string, number: number) =>
  api(state, 'GET', `/tasks/${id}/checks/${number}`).then((a) =>
    json<{ state: string; end?: { exitCode?: number }; report?: { summary: string } }>(a),
  );

const journalNames = async (root: string): Promise<string[]> =>
  (await readdir(journalDir(root)).catch(() => [] as string[])).sort();

const checkRecord = (extra: Partial<CheckJournal> = {}): CheckJournal => ({
  formatVersion: 1,
  kind: 'check',
  taskId: 'T1',
  check: 1,
  sessionId: SESSION,
  ...extra,
});

describe('local-project-board claude <ID> --check', () => {
  it('starts claude with the prompt of the handoff of this check, and begins the check first', async () => {
    const { root, state } = await board();
    const claude = await fakeClaude();

    const run = await cli(['claude', 'T2', '--check'], { cwd: root, env: claude.env() });

    expect(run.exitCode).toBe(0);
    expect(run.err).toEqual([]);
    const [call] = await claude.calls();
    expect(call?.argv).toHaveLength(3);
    expect(call?.argv[0]).toBe('--session-id');
    expect(call?.argv[2]).toBe(claudeCheckPrompt('T2', 1, boardUrl(state)));
    expect(call?.argv[2]).toContain('/api/v1/tasks/T2/checks/1/handoff');
    const check = await json<{ begin: { sessionId: string; version: number } }>(
      await api(state, 'GET', '/tasks/T2/checks/1'),
    );
    expect(check.begin.sessionId).toBe(call?.argv[1]);
    expect(check.begin.version).toBe(1);
  });

  it('does not touch the run of the task, its status or its content (INVARIANT)', async () => {
    const { root, state } = await board();
    const claude = await fakeClaude();
    const before = await json<Record<string, unknown>>(await api(state, 'GET', '/tasks/T2'));

    await cli(['claude', 'T2', '--check'], { cwd: root, env: claude.env() });

    const after = await json<Record<string, unknown>>(await api(state, 'GET', '/tasks/T2'));
    expect(after).toEqual(before);
    expect(after).not.toHaveProperty('aiRun');
  });

  it('never gives the token to claude: not in its arguments, not in its environment', async () => {
    const { root, state } = await board();
    const claude = await fakeClaude();
    const run = await cli(['claude', 'T1', '--check'], { cwd: root, env: claude.env() });
    expect(JSON.stringify(await claude.calls())).not.toContain(state.token);
    expect(run.text).not.toContain(state.token);
  });

  it('lets the agent read the handoff of the check and report, and ends the check as claude ended', async () => {
    const { root, state } = await board();
    const claude = await fakeClaude();

    const run = await cli(['claude', 'T1', '--check'], {
      cwd: root,
      env: claude.env({ agent: 'check', exit: 0 }),
    });

    expect(run.exitCode).toBe(0);
    const [read] = await claude.reads();
    expect(read?.handoff).toContain('# Check T1-C1: is task T1 still current?');
    expect(read?.handoff).toContain('Extract the git adapter');
    const check = await checkOf(state, 'T1', 1);
    expect(check.state).toBe('reported');
    expect(check.report?.summary).toBe('Still current.');
    expect(check.end).toBeDefined();
    // The journal is gone once the board took the end.
    expect(await journalNames(root)).toEqual([]);
  });

  it('ends a check whose agent never reported as failed, with the exit code of claude', async () => {
    const { root, state } = await board();
    const claude = await fakeClaude();

    const run = await cli(['claude', 'T1', '--check'], { cwd: root, env: claude.env({ exit: 3 }) });

    expect(run.exitCode).toBe(3);
    const check = await checkOf(state, 'T1', 1);
    expect(check).toMatchObject({ state: 'failed', end: { exitCode: 3 } });
  });

  it('numbers each check anew, and the second does not replace the first', async () => {
    const { root, state } = await board();
    const claude = await fakeClaude();
    await cli(['claude', 'T1', '--check'], { cwd: root, env: claude.env({ agent: 'check' }) });
    await cli(['claude', 'T1', '--check'], { cwd: root, env: claude.env({ exit: 1 }) });
    expect((await checkOf(state, 'T1', 1)).state).toBe('reported');
    expect((await checkOf(state, 'T1', 2)).state).toBe('failed');
  });

  it('refuses a task that does not exist, and a board that is not running, before any session', async () => {
    const { root } = await board();
    const claude = await fakeClaude();
    const missing = await cli(['claude', 'T99', '--check'], { cwd: root, env: claude.env() });
    expect(missing.exitCode).toBe(1);
    expect(await claude.calls()).toEqual([]);
  });

  it('takes the flag only with claude and an id', async () => {
    const root = await tmpDir();
    for (const argv of [
      ['handoff', 'T1', '--check'],
      ['claude', '--wait', '--check'],
      ['claude', 'T1', '--check', '--recover'],
    ]) {
      const run = await cli(argv, { cwd: root });
      expect([argv, run.exitCode]).toEqual([argv, 1]);
      expect(run.text).toContain('Usage:');
    }
    const bare = await cli(['claude', '--check'], { cwd: root });
    expect(bare.exitCode).toBe(1);
  });
});

describe('the runner of claude --wait with a check', () => {
  it('starts a session on the check the board handed it, not on a run', async () => {
    const { root, state } = await board();
    const claude = await fakeClaude();
    const runner = cliInBackground(['claude', '--wait'], { cwd: root, env: claude.env() });
    await runner.printed(WAITING);

    const answer = await api(state, 'POST', '/tasks/T2/run', {
      agent: 'claude-code',
      kind: 'check',
    });

    expect(answer.status).toBe(200);
    const [call] = await until(claude.calls, (calls) => calls.length >= 1);
    expect(call?.argv[2]).toBe(claudeCheckPrompt('T2', 1, boardUrl(state)));
    await runner.printed(/^Starting Claude Code on a check of T2\./);
    await until(
      () => checkOf(state, 'T2', 1),
      (check) => check.state === 'failed',
    );
    expect(
      await json<Record<string, unknown>>(await api(state, 'GET', '/tasks/T2')),
    ).not.toHaveProperty('aiRun');
    // It waits again when the session is over.
    await runner.printed(WAITING, 2);
  });

  it('passes the model as two arguments when the check was sent with one, and as none otherwise', async () => {
    const { root, state } = await board();
    const claude = await fakeClaude();
    const runner = cliInBackground(['claude', '--wait'], { cwd: root, env: claude.env() });
    await runner.printed(WAITING);

    await api(state, 'POST', '/tasks/T1/run', {
      agent: 'claude-code',
      kind: 'check',
      model: 'sonnet',
    });
    const [chosen] = await until(claude.calls, (calls) => calls.length >= 1);
    expect(chosen?.argv.slice(0, 2)).toEqual(['--model', 'sonnet']);
    expect(chosen?.argv).toHaveLength(5);
    expect(
      await json<{ begin: { model?: string } }>(await api(state, 'GET', '/tasks/T1/checks/1')),
    ).toMatchObject({ begin: { model: 'sonnet' } });

    await runner.printed(WAITING, 2);
    await api(state, 'POST', '/tasks/T2/run', { agent: 'claude-code', kind: 'check' });
    const calls = await until(claude.calls, (found) => found.length >= 2);
    expect(calls[1]?.argv.some((a) => a.startsWith('--model'))).toBe(false);
  });
});

describe('the journal of a check (ADR-0030 §6)', () => {
  it('lives in a file of its own, <ID>-check-<n>.json, and is not a work journal (INVARIANT)', async () => {
    const root = await tmpDir();
    await writeCheckJournal(root, checkRecord({ check: 3 }));

    expect(await journalNames(root)).toEqual(['T1-check-3.json']);
    expect(await listCheckJournals(root)).toEqual([checkRecord({ check: 3 })]);
    // The strict schema of a work journal does not read it, and nothing builds its name.
    expect(await listJournals(root)).toEqual([]);
    expect(await readJournal(root, 'T1', 3)).toBeUndefined();
    expect(await readJournal(root, 'T1-check', 3)).toBeUndefined();
  });

  it('cannot overwrite the journal of a run with the same number, nor be overwritten by it', async () => {
    const root = await tmpDir();
    const run: RunJournal = {
      formatVersion: 1,
      taskId: 'T1',
      runId: 3,
      sessionId: SESSION,
      host: 'box',
      platform: 'linux',
      runner: { pid: 4200 },
    };
    await writeJournal(root, run);
    await writeCheckJournal(root, checkRecord({ check: 3 }));
    await writeJournal(root, { ...run, child: { pid: 4242 } });

    expect(await journalNames(root)).toEqual(['T1-3.json', 'T1-check-3.json']);
    expect(await listJournals(root)).toEqual([{ ...run, child: { pid: 4242 } }]);
    expect(await listCheckJournals(root)).toEqual([checkRecord({ check: 3 })]);
  });

  it('is written owner-only, holds no token, and names its kind and check', async () => {
    const root = await tmpDir();
    await writeCheckJournal(root, checkRecord());
    const text = await readFile(join(journalDir(root), 'T1-check-1.json'), 'utf8');
    expect(JSON.parse(text)).toEqual({
      formatVersion: 1,
      kind: 'check',
      taskId: 'T1',
      check: 1,
      sessionId: SESSION,
    });
    const { stat } = await import('node:fs/promises');
    expect((await stat(join(journalDir(root), 'T1-check-1.json'))).mode & 0o777).toBe(0o600);
    expect(checkJournalSchema.safeParse({ ...checkRecord(), token: 'x' }).success).toBe(false);
  });

  it('is left where it is when it is damaged or when its name and its record disagree', async () => {
    const root = await tmpDir();
    await mkdir(journalDir(root), { recursive: true });
    await writeFile(join(journalDir(root), 'T1-check-1.json'), '{ nope', 'utf8');
    await writeFile(
      join(journalDir(root), 'T1-check-2.json'),
      JSON.stringify(checkRecord({ check: 5 })),
      'utf8',
    );
    expect(await listCheckJournals(root)).toEqual([]);
    expect(await journalNames(root)).toEqual(['T1-check-1.json', 'T1-check-2.json']);
  });
});

describe('claude --recover is not extended by checks (INVARIANT)', () => {
  it('leaves the journal of a check alone, and recovers the run with the same number as before', async () => {
    const { root, state } = await board();
    await api(state, 'POST', '/tasks/T1/ai-run', { sessionId: SESSION, mode: 'new' });
    await api(state, 'POST', '/tasks/T1/checks', { agent: 'claude-code', sessionId: SESSION });
    await writeCheckJournal(root, checkRecord());

    const run = await cli(['claude', '--recover', 'T1'], { cwd: root });

    // Without a journal of the run there is nothing to prove; the check journal is not one.
    expect(run.exitCode).toBe(1);
    expect(await journalNames(root)).toEqual(['T1-check-1.json']);
    expect(await checkOf(state, 'T1', 1)).toMatchObject({ state: 'working' });
  });
});

describe('delivering the end of a check', () => {
  async function begun(): Promise<{ root: string; state: RuntimeState }> {
    const { root, state } = await board();
    const answer = await api(state, 'POST', '/tasks/T1/checks', {
      agent: 'claude-code',
      sessionId: SESSION,
    });
    expect(answer.status).toBe(200);
    return { root, state };
  }

  it('ends the check on the board and removes the journal when the board takes it', async () => {
    const { root, state } = await begun();
    await writeCheckJournal(
      root,
      checkRecord({ outcome: { exitCode: 2, endedAt: '2026-10-17T10:00:00.000Z' } }),
    );

    await deliverPendingCheckEnds(root);

    expect(await checkOf(state, 'T1', 1)).toMatchObject({ state: 'failed', end: { exitCode: 2 } });
    expect(await journalNames(root)).toEqual([]);
  });

  it.each([
    [
      'the end was taken already (409)',
      async (state: RuntimeState) => {
        await api(state, 'POST', '/tasks/T1/checks/1/end', { sessionId: SESSION });
      },
      checkRecord({ outcome: { endedAt: '2026-10-17T10:00:00.000Z' } }),
    ],
    [
      'another session ended it (409)',
      async () => undefined,
      checkRecord({
        sessionId: 'b1b2c3d4-e5f6-4890-abcd-ef0123456789',
        outcome: { endedAt: '2026-10-17T10:00:00.000Z' },
      }),
    ],
    [
      'the check is gone (404)',
      async () => undefined,
      checkRecord({
        check: 9,
        outcome: { endedAt: '2026-10-17T10:00:00.000Z' },
      }),
    ],
  ])('removes the journal when %s', async (_name, prepare, record) => {
    const { root, state } = await begun();
    await prepare(state);
    await writeCheckJournal(root, record);
    await deliverPendingCheckEnds(root);
    expect(await journalNames(root)).toEqual([]);
  });

  it('keeps the journal when the board is not there, and delivers it when it is back', async () => {
    const root = await tmpDir();
    await writeCheckJournal(
      root,
      checkRecord({ outcome: { endedAt: '2026-10-17T10:00:00.000Z' } }),
    );
    await deliverPendingCheckEnds(root);
    expect(await journalNames(root)).toEqual(['T1-check-1.json']);
  });

  it('drops a journal without an outcome once the board shows the check with a report or an end, or has none', async () => {
    const { root, state } = await begun();
    await writeCheckJournal(root, checkRecord());
    await writeCheckJournal(root, checkRecord({ check: 7 }));

    // The check works: nothing it holds is settled yet, so it stays; 7 does not exist, so it goes.
    await deliverPendingCheckEnds(root);
    expect(await journalNames(root)).toEqual(['T1-check-1.json']);

    await api(state, 'POST', '/tasks/T1/checks/1/end', { sessionId: SESSION });
    await deliverPendingCheckEnds(root);
    expect(await journalNames(root)).toEqual([]);
  });

  it('is never judged against aiRun: a task with a later run does not drop it (INVARIANT)', async () => {
    const { root, state } = await begun();
    expect(
      (
        await api(state, 'POST', '/tasks/T1/ai-run', {
          sessionId: 'c1b2c3d4-e5f6-4890-abcd-ef0123456789',
          mode: 'new',
        })
      ).status,
    ).toBe(200);
    await writeCheckJournal(root, checkRecord());
    await deliverPendingCheckEnds(root);
    expect(await journalNames(root)).toEqual(['T1-check-1.json']);
  });

  it('is skipped by the delivery of work runs, which stays as it was (INVARIANT)', async () => {
    const { root, state } = await begun();
    expect(
      (await api(state, 'POST', '/tasks/T1/ai-run', { sessionId: SESSION, mode: 'new' })).status,
    ).toBe(200);
    await writeCheckJournal(
      root,
      checkRecord({ check: 1, outcome: { endedAt: '2026-10-17T10:00:00.000Z' } }),
    );
    await writeJournal(root, {
      formatVersion: 1,
      taskId: 'T1',
      runId: 1,
      sessionId: SESSION,
      host: 'box',
      platform: 'linux',
      runner: { pid: 4200 },
      outcome: { exitCode: 0, endedAt: '2026-10-17T10:00:00.000Z' },
    });

    await deliverPendingEnds(root);

    // The run's end was delivered and its journal removed; the check's end was not touched.
    expect(await journalNames(root)).toEqual(['T1-check-1.json']);
    expect(await checkOf(state, 'T1', 1)).toMatchObject({ state: 'working' });
    const task = await json<{ aiRun: { state: string } }>(await api(state, 'GET', '/tasks/T1'));
    expect(task.aiRun.state).toBe('failed');
  });
});
