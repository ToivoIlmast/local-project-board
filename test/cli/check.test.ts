import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeCheckPrompt, researchPrompt } from '../../src/contract/v1/index.js';
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

async function board(): Promise<{
  root: string;
  state: RuntimeState;
  stop: () => Promise<void>;
}> {
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
  return { root, state: runtime.state, stop: start.stop ?? (() => Promise.resolve()) };
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
    json<{
      state: string;
      begin: { comment?: string };
      end?: { exitCode?: number };
      report?: { summary: string };
    }>(a),
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

/**
 * `claude <ID> --research [--comment <text>]` and the runner with `kind: 'research'` (ADR-0029
 * T54): a research is a check of its own kind (ADR-0030 R1). It starts the same way, with the
 * same journal; the comment goes to the begin and the handoff, and never to the command line.
 */
describe('local-project-board claude <ID> --research', () => {
  // Unlike anything the board or the test would print, so that a leak cannot hide.
  const COMMENT = 'FOCUS-7f3a: look only at the runner; "quoted" $(not run) --model opus';

  const beginFile = (root: string, id: string, n: number): Promise<string> =>
    readFile(join(root, '.board', 'tasks', id, 'history', 'checks', `${n}.begin.json`), 'utf8');

  const researchOf = (state: RuntimeState, id: string, n: number) =>
    api(state, 'GET', `/tasks/${id}/checks/${n}`).then((a) =>
      json<{ state: string; begin: { kind?: string; comment?: string; sessionId: string } }>(a),
    );

  it('puts the comment in the begin and the handoff, and never in the argv or env of claude (INVARIANT)', async () => {
    const { root, state } = await board();
    const claude = await fakeClaude();

    const run = await cli(['claude', 'T2', '--research', '--comment', COMMENT], {
      cwd: root,
      env: claude.env({ agent: 'read' }),
    });

    expect(run.exitCode).toBe(0);
    const calls = await claude.calls();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.argv).toEqual([
      '--session-id',
      expect.any(String),
      researchPrompt('T2', 1, boardUrl(state)),
    ]);
    expect(JSON.stringify(calls)).not.toContain('FOCUS-7f3a');
    expect(JSON.parse(await beginFile(root, 'T2', 1))).toMatchObject({
      kind: 'research',
      comment: COMMENT,
      sessionId: call?.argv[1],
    });
    const [read] = await claude.reads();
    expect(read?.handoff).toContain(COMMENT);
  });

  it('begins a research without a comment, and leaves the run of the task alone (INVARIANT)', async () => {
    const { root, state } = await board();
    const claude = await fakeClaude();
    const before = await json<Record<string, unknown>>(await api(state, 'GET', '/tasks/T1'));

    await cli(['claude', 'T1', '--research'], { cwd: root, env: claude.env() });

    const begin = (await researchOf(state, 'T1', 1)).begin;
    expect(begin.kind).toBe('research');
    expect(begin).not.toHaveProperty('comment');
    const after = await json<Record<string, unknown>>(await api(state, 'GET', '/tasks/T1'));
    expect(after).toEqual(before);
    expect(after).not.toHaveProperty('aiRun');
  });

  it('refuses a comment the route would refuse, before any session', async () => {
    const { root } = await board();
    const claude = await fakeClaude();
    const run = await cli(['claude', 'T1', '--research', '--comment', 'x'.repeat(4001)], {
      cwd: root,
      env: claude.env(),
    });
    expect(run.exitCode).toBe(1);
    expect(run.text).toContain('Usage:');
    expect(await claude.calls()).toEqual([]);
  });
});

describe('the runner of claude --wait with a research', () => {
  const COMMENT = 'FOCUS-91c2: the dispatch only';

  it('starts a check session of kind research, not a run, with the comment on the board only (INVARIANT)', async () => {
    const { root, state } = await board();
    const claude = await fakeClaude();
    const runner = cliInBackground(['claude', '--wait'], {
      cwd: root,
      env: claude.env({ agent: 'read' }),
    });
    await runner.printed(WAITING);

    const answer = await api(state, 'POST', '/tasks/T2/run', {
      agent: 'claude-code',
      kind: 'research',
      comment: COMMENT,
      model: 'sonnet',
    });

    expect(answer.status).toBe(200);
    const [call] = await until(claude.calls, (calls) => calls.length >= 1);
    expect(call?.argv).toEqual([
      '--model',
      'sonnet',
      '--session-id',
      expect.any(String),
      researchPrompt('T2', 1, boardUrl(state)),
    ]);
    expect(JSON.stringify(call)).not.toContain('FOCUS-91c2');
    await runner.printed(/^Starting Claude Code on a research of T2\./);
    const check = await until(
      () => checkOf(state, 'T2', 1),
      (found) => found.end !== undefined,
    );
    expect(check).toMatchObject({
      begin: { kind: 'research', comment: COMMENT, model: 'sonnet', sessionId: call?.argv[3] },
    });
    const [read] = await claude.reads();
    expect(read?.handoff).toContain(COMMENT);
    expect(
      await json<Record<string, unknown>>(await api(state, 'GET', '/tasks/T2')),
    ).not.toHaveProperty('aiRun');
    await runner.printed(WAITING, 2);
  });

  it('two researches with different comments get two numbers, and the second replaces nothing', async () => {
    const { root, state } = await board();
    const claude = await fakeClaude();
    const runner = cliInBackground(['claude', '--wait'], { cwd: root, env: claude.env() });
    await runner.printed(WAITING);

    for (const [n, comment] of [
      [1, 'First focus.'],
      [2, 'Second focus.'],
    ] as const) {
      await runner.printed(WAITING, n);
      const answer = await api(state, 'POST', '/tasks/T1/run', {
        agent: 'claude-code',
        kind: 'research',
        comment,
      });
      expect(answer.status).toBe(200);
      await until(
        () => checkOf(state, 'T1', n),
        (found) => found.end !== undefined,
      );
    }

    expect(await checkOf(state, 'T1', 1)).toMatchObject({ begin: { comment: 'First focus.' } });
    expect(await checkOf(state, 'T1', 2)).toMatchObject({ begin: { comment: 'Second focus.' } });
  });

  it('two researches of one task at once, on two runners: two numbers, neither overwritten', async () => {
    const { root, state } = await board();
    const claude = await fakeClaude();
    const release = join(await tmpDir(), 'release');
    const env = claude.env({ holdUntil: release });
    const first = cliInBackground(['claude', '--wait'], { cwd: root, env });
    await first.printed(WAITING);
    const second = cliInBackground(['claude', '--wait'], { cwd: root, env });
    await second.printed(WAITING);

    for (const comment of ['Left.', 'Right.']) {
      const answer = await api(state, 'POST', '/tasks/T1/run', {
        agent: 'claude-code',
        kind: 'research',
        comment,
      });
      expect(answer.status).toBe(200);
    }
    const calls = await until(claude.calls, (found) => found.length >= 2);
    expect(new Set(calls.map((c) => c.argv[1])).size).toBe(2);
    expect(await journalNames(root)).toEqual(['T1-check-1.json', 'T1-check-2.json']);

    await writeFile(release, '', 'utf8');
    const ends = await Promise.all(
      [1, 2].map((n) =>
        until(
          () => checkOf(state, 'T1', n),
          (found) => found.end !== undefined,
        ),
      ),
    );
    const comments = ends.map((check) => check.begin.comment);
    expect(comments.sort()).toEqual(['Left.', 'Right.']);
    // The runner removes its journal once the board has taken the end, a moment later.
    const left = await until(
      () => journalNames(root),
      (names) => names.length === 0,
    );
    expect(left).toEqual([]);
    // Each runner may still be delivering the other's end when it is told to stop: it stops.
    expect((await first.stop()).exitCode).toBe(0);
    expect((await second.stop()).exitCode).toBe(0);
  });
});

describe('the journal of a research (ADR-0029 T54)', () => {
  it('is the journal of a check, holds no comment, and leaves a work journal of the same number alone (INVARIANT)', async () => {
    const { root, state } = await board();
    const claude = await fakeClaude();
    // A work run of the same task with the same number, whose journal must not be touched.
    expect(
      (await api(state, 'POST', '/tasks/T1/ai-run', { sessionId: SESSION, mode: 'new' })).status,
    ).toBe(200);
    const work: RunJournal = {
      formatVersion: 1,
      taskId: 'T1',
      runId: 1,
      sessionId: SESSION,
      host: 'box',
      platform: 'linux',
      runner: { pid: 4200 },
    };
    await writeJournal(root, work);
    const workText = await readFile(join(journalDir(root), 'T1-1.json'), 'utf8');
    const release = join(await tmpDir(), 'release');
    const session = cliInBackground(['claude', 'T1', '--research', '--comment', 'FOCUS-a1'], {
      cwd: root,
      env: claude.env({ holdUntil: release }),
    });
    await until(claude.calls, (calls) => calls.length >= 1);

    expect(await journalNames(root)).toEqual(['T1-1.json', 'T1-check-1.json']);
    const text = await readFile(join(journalDir(root), 'T1-check-1.json'), 'utf8');
    expect(checkJournalSchema.parse(JSON.parse(text))).toMatchObject({ kind: 'check', check: 1 });
    expect(text).not.toContain('FOCUS-a1');

    // --recover reads the work journal only, and leaves the research's alone.
    await cli(['claude', '--recover', 'T1'], { cwd: root });
    expect(await journalNames(root)).toContain('T1-check-1.json');
    expect(await checkOf(state, 'T1', 1)).toMatchObject({ state: 'working' });

    await writeFile(release, '', 'utf8');
    expect((await session.done).exitCode).toBe(0);
    expect((await checkOf(state, 'T1', 1)).end).toBeDefined();
    expect(await journalNames(root)).toEqual(['T1-1.json']);
    expect(await readFile(join(journalDir(root), 'T1-1.json'), 'utf8')).toBe(workText);
  });

  it('delivers the end to the board that was restarted while the research ran', async () => {
    const { root, state, stop } = await board();
    const claude = await fakeClaude();
    const release = join(await tmpDir(), 'release');
    const session = cliInBackground(['claude', 'T1', '--research'], {
      cwd: root,
      env: claude.env({ holdUntil: release, exit: 4 }),
    });
    await until(claude.calls, (calls) => calls.length >= 1);

    await stop();
    const again = await cli(['--port', String(await freePort()), '--no-open'], { cwd: root });
    expect(again.exitCode).toBe(0);
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');
    expect(runtime.state.token).not.toBe(state.token);

    await writeFile(release, '', 'utf8');
    expect((await session.done).exitCode).toBe(4);
    expect(await checkOf(runtime.state, 'T1', 1)).toMatchObject({
      state: 'failed',
      end: { exitCode: 4 },
    });
    expect(await journalNames(root)).toEqual([]);
  });
});
