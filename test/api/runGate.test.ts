import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  API_BASE_PATH as API,
  errorResponseSchema,
  routes,
  runRequestSchema,
  taskSchema,
  type RunRequest,
} from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { openStream, type SseClient } from '../support/sse.js';
import { cleanTmpDirs } from '../support/tmp.js';

/**
 * The readiness gate of a work run (T86; ADR-0029 amendment T78, L1–L6; ADR-0032 §8): a blocked
 * task is refused at `/run`, after the refusals that were there before, and again at begin, the
 * last guard on the server. A check and a research are not gated, a run that has started is not
 * stopped, and the handoff is refused only while no run works.
 */

let board: TestBoard;
const open: SseClient<RunRequest>[] = [];

const RUNS = `${API}${routes['runs.stream'].path}`;
const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';
const OTHER_SESSION = 'b2c3d4e5-f6a7-4890-abcd-ef0123456789';
const BLOCKED_BY_T1 = [{ code: 'task-not-done', task: 'T1' }];

beforeEach(async () => {
  board = await createTestBoard();
  // T1 is the dependency; T2 is the task the tests block and unblock through it.
  await board.post(`${API}/tasks`, { title: 'Dependency', status: 'todo' }).expect(201);
  await board.post(`${API}/tasks`, { title: 'Dependant', status: 'todo' }).expect(201);
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  await board.close();
  await cleanTmpDirs();
});

const error = (body: unknown) => errorResponseSchema.parse(body).error;

async function runner(accepts?: string): Promise<SseClient<RunRequest>> {
  const path = accepts === undefined ? RUNS : `${RUNS}?accepts=${accepts}`;
  const client = await openStream(
    board.port,
    path,
    { authorization: `Bearer ${board.token}` },
    (data) => runRequestSchema.parse(data),
  );
  open.push(client);
  return client;
}

const run = (id: string, extra: Record<string, unknown> = {}) =>
  board.post(`${API}/tasks/${id}/run`, { agent: 'claude-code', ...extra });
const begin = (id: string, body: Record<string, unknown> = {}) =>
  board.post(`${API}/tasks/${id}/ai-run`, { sessionId: SESSION, mode: 'new', ...body });
const block = (id = 'T2') => board.patch(`${API}/tasks/${id}`, { dependsOn: ['T1'] }).expect(200);
const unblock = () => board.patch(`${API}/tasks/T1`, { status: 'done' }).expect(200);
const getTask = async (id: string) => (await board.get(`${API}/tasks/${id}`).expect(200)).body;

/** A run as the runner leaves it: begun with a session, then ended as its process ended. */
async function ranAndEnded(id: string): Promise<number> {
  const runId = ((await begin(id).expect(200)).body as { runId: number }).runId;
  await board.post(`${API}/tasks/${id}/ai-run/${runId}/end`, { exitCode: 1 }).expect(200);
  return runId;
}

/** Everything a refused start could have touched: the file of the task, its run, the events. */
async function written(id: string) {
  const file = await readFile(join(board.root, '.board', 'tasks', id, 'task.md'), 'utf8');
  const task = (await getTask(id)) as { aiRun?: unknown };
  return { file, aiRun: task.aiRun, events: board.events.events.length };
}

function expectBlocked(body: unknown, id = 'T2', reasons: unknown[] = BLOCKED_BY_T1): void {
  const { code, details, message } = error(body);
  expect(code).toBe('TASK_BLOCKED');
  expect(details).toEqual({ id, reasons });
  expect(message).toContain(id);
}

describe('POST /tasks/:id/run refuses a blocked task in every mode (L1)', () => {
  it('New: 409 TASK_BLOCKED with the reasons; no runner is asked, nothing is written (INVARIANT)', async () => {
    await block();
    const waiting = await runner();
    const before = await written('T2');

    const response = await run('T2').expect(409);

    expectBlocked(response.body);
    expect(waiting.events).toEqual([]);
    expect(waiting.ended()).toBe(false);
    expect(await written('T2')).toEqual(before);
    expect(((await getTask('T2')) as { aiRun?: unknown }).aiRun).toBeUndefined();
  });

  it('Resume: refused, and the session of the last run is kept for when the task is ready (INVARIANT)', async () => {
    const runId = await ranAndEnded('T2');
    await block();
    const waiting = await runner();
    const before = await written('T2');

    const response = await run('T2', { mode: 'resume' }).expect(409);

    expectBlocked(response.body);
    expect(waiting.events).toEqual([]);
    expect(await written('T2')).toEqual(before);
    const { aiRun } = (await getTask('T2')) as { aiRun: { runId: number; sessionId: string } };
    expect(aiRun).toMatchObject({ runId, sessionId: SESSION, state: 'failed' });

    // Once the task is ready, Resume continues that very session.
    await unblock();
    await run('T2', { mode: 'resume' }).expect(200);
    await waiting.waitForEvents(1);
    expect(waiting.events).toEqual([
      { type: 'run.requested', taskId: 'T2', agent: 'claude-code', mode: 'resume' },
    ]);
  });

  it('Restart: refused, no runId is allocated, the last run is unchanged (INVARIANT)', async () => {
    const runId = await ranAndEnded('T2');
    await block();
    const waiting = await runner();
    const before = await written('T2');

    const response = await run('T2', { mode: 'restart' }).expect(409);

    expectBlocked(response.body);
    expect(waiting.events).toEqual([]);
    expect(await written('T2')).toEqual(before);
    expect(((await getTask('T2')) as { aiRun: { runId: number } }).aiRun.runId).toBe(runId);
  });

  it('is answered before NO_AGENT_RUNNER: nothing waits, and still the reasons are said', async () => {
    await block();

    expectBlocked((await run('T2').expect(409)).body);
  });

  it('carries every reason, as readiness computes them', async () => {
    await board.post(`${API}/tasks`, { title: 'Third', status: 'todo' }).expect(201);
    await board.patch(`${API}/tasks/T2`, { dependsOn: ['T1', 'T3'] }).expect(200);

    expectBlocked((await run('T2').expect(409)).body, 'T2', [
      { code: 'task-not-done', task: 'T1' },
      { code: 'task-not-done', task: 'T3' },
    ]);
  });

  it('a task that is ready is handed as before, the reasons gone with their cause', async () => {
    await block();
    await unblock();
    const waiting = await runner();

    await run('T2').expect(200);

    await waiting.waitForEvents(1);
    expect(waiting.events).toEqual([{ type: 'run.requested', taskId: 'T2', agent: 'claude-code' }]);
  });
});

describe('the refusals that were there before come first (L1, F4)', () => {
  it('AI_RUN_IN_PROGRESS, in every mode, while a run of the blocked task works', async () => {
    await begin('T2').expect(200);
    await block();
    const waiting = await runner();

    for (const mode of ['new', 'resume', 'restart']) {
      expect(error((await run('T2', { mode }).expect(409)).body).code).toBe('AI_RUN_IN_PROGRESS');
    }
    expect(waiting.events).toEqual([]);
  });

  it('NO_SESSION_TO_RESUME for a blocked task that never ran', async () => {
    await block();

    expect(error((await run('T2', { mode: 'resume' }).expect(409)).body).code).toBe(
      'NO_SESSION_TO_RESUME',
    );
  });

  it('NO_RUN_TO_RESTART for a blocked task that never ran', async () => {
    await block();

    expect(error((await run('T2', { mode: 'restart' }).expect(409)).body).code).toBe(
      'NO_RUN_TO_RESTART',
    );
  });

  it('TASK_NOT_FOUND and INVALID_REQUEST stay what they were', async () => {
    expect(error((await run('T9').expect(404)).body).code).toBe('TASK_NOT_FOUND');
    await block();
    expect(error((await run('T2', { mode: 'continue' }).expect(400)).body).code).toBe(
      'INVALID_REQUEST',
    );
  });
});

describe('begin refuses a blocked task too: the last guard on the server (L2)', () => {
  it('a task blocked between /run and begin is refused at begin; no runId, aiRun unchanged (INVARIANT)', async () => {
    const waiting = await runner();
    // /run passes its check: the task is ready, and the runner is told.
    await run('T2').expect(200);
    await waiting.waitForEvents(1);
    // Then, before the runner begins, the task becomes blocked.
    await block();
    const before = await written('T2');

    const response = await begin('T2').expect(409);

    expectBlocked(response.body);
    expect(await written('T2')).toEqual(before);
    expect(((await getTask('T2')) as { aiRun?: unknown }).aiRun).toBeUndefined();
  });

  it('the same race for Resume and Restart: the last run and its session stay as they were', async () => {
    const runId = await ranAndEnded('T2');
    for (const mode of ['resume', 'restart']) {
      const waiting = await runner();
      await run('T2', { mode }).expect(200);
      await waiting.waitForEvents(1);
      await block();
      const before = await written('T2');

      expectBlocked((await begin('T2', { mode }).expect(409)).body);

      expect(await written('T2')).toEqual(before);
      expect((await getTask('T2')) as { aiRun: unknown }).toMatchObject({
        aiRun: { runId, sessionId: SESSION, state: 'failed' },
      });
      // Ready again for the next mode.
      await board.patch(`${API}/tasks/T2`, { dependsOn: null }).expect(200);
    }
  });

  it('`claude <ID>` goes through begin alone, and is refused there', async () => {
    await block();
    const before = await written('T2');

    expectBlocked((await begin('T2').expect(409)).body);
    expect(await written('T2')).toEqual(before);
  });

  it('after the refusals begin already makes: AI_RUN_IN_PROGRESS, NO_RUN_TO_RESTART, NO_SESSION_TO_RESUME', async () => {
    await block();
    expect(error((await begin('T2', { mode: 'restart' }).expect(409)).body).code).toBe(
      'NO_RUN_TO_RESTART',
    );
    expect(error((await begin('T2', { mode: 'resume' }).expect(409)).body).code).toBe(
      'NO_SESSION_TO_RESUME',
    );

    await board.patch(`${API}/tasks/T2`, { dependsOn: null }).expect(200);
    await begin('T2').expect(200);
    await block();
    expect(error((await begin('T2', { sessionId: OTHER_SESSION }).expect(409)).body).code).toBe(
      'AI_RUN_IN_PROGRESS',
    );
  });
});

describe('a check and a research are not gated (L3)', () => {
  it('are handed to a runner and begun on a blocked task', async () => {
    await block();
    const waiting = await runner('check,research');

    await run('T2', { kind: 'check' }).expect(200);
    await waiting.waitForEvents(1);
    expect(waiting.events[0]).toMatchObject({ taskId: 'T2', kind: 'check' });
    await board
      .post(`${API}/tasks/T2/checks`, { agent: 'claude-code', sessionId: SESSION })
      .expect(200);

    const second = await runner('check,research');
    await run('T2', { kind: 'research' }).expect(200);
    await second.waitForEvents(1);
    expect(second.events[0]).toMatchObject({ taskId: 'T2', kind: 'research' });
    await board
      .post(`${API}/tasks/T2/checks`, {
        agent: 'claude-code',
        sessionId: OTHER_SESSION,
        kind: 'research',
      })
      .expect(200);

    // Neither touched the run of the task.
    expect(((await getTask('T2')) as { aiRun?: unknown }).aiRun).toBeUndefined();
  });
});

describe('a run that has started is not stopped (L4)', () => {
  it('keeps working once its task becomes blocked; report and end are taken', async () => {
    const runId = ((await begin('T2').expect(200)).body as { runId: number }).runId;
    await block();

    const blocked = (await getTask('T2')) as {
      aiRun: { state: string };
      readiness: { reasons: unknown[] };
    };
    expect(blocked.aiRun.state).toBe('working');
    expect(blocked.readiness.reasons).toEqual(BLOCKED_BY_T1);

    await board
      .patch(`${API}/tasks/T2/ai-run/${runId}/report`, {
        agent: 'claude-code',
        state: 'finished',
        checks: 'passed',
      })
      .expect(200);
    await board.post(`${API}/tasks/T2/ai-run/${runId}/end`, { exitCode: 0 }).expect(200);
    expect(((await getTask('T2')) as { aiRun: { state: string } }).aiRun.state).toBe('finished');
  });
});

describe('GET /tasks/:id/handoff of a blocked task (ADR-0032 §8, F1)', () => {
  const handoff = (id = 'T2') => board.get(`${API}/tasks/${id}/handoff`);

  it('is 409 TASK_BLOCKED with the reasons while no run works', async () => {
    await block();
    expectBlocked((await handoff().expect(409)).body);

    await unblock();
    expect((await handoff().expect(200)).text).toContain('# Task T2: Dependant');
  });

  it('is refused too after a run of it ended', async () => {
    await ranAndEnded('T2');
    await block();

    expectBlocked((await handoff().expect(409)).body);
  });

  it('is always given to a run that works, a resumed one included (INVARIANT)', async () => {
    const runId = await begin('T2')
      .expect(200)
      .then((answer) => (answer.body as { runId: number }).runId);
    await block();
    expect((await handoff().expect(200)).text).toContain('# Task T2: Dependant');

    // A run that resumed before the task became blocked keeps its handoff as well.
    await board.patch(`${API}/tasks/T2`, { dependsOn: null }).expect(200);
    await board.post(`${API}/tasks/T2/ai-run/${runId}/end`, { exitCode: 1 }).expect(200);
    await begin('T2', { mode: 'resume' }).expect(200);
    await block();
    expect((await handoff().expect(200)).text).toContain('# Task T2: Dependant');
  });

  it('the handoff of a check is not affected', async () => {
    await block();
    await board
      .post(`${API}/tasks/T2/checks`, { agent: 'claude-code', sessionId: SESSION })
      .expect(200);

    await board.get(`${API}/tasks/T2/checks/1/handoff`).expect(200);
  });
});

describe('GET /tasks and GET /tasks/:id carry readiness, apart from the task (F3)', () => {
  it('every task of the list comes with its reasons; an empty list means ready', async () => {
    await block();

    const response = await board.get(`${API}/tasks`).expect(200);

    expect(() => routes['tasks.list'].response.schema.parse(response.body)).not.toThrow();
    const byId = Object.fromEntries(
      (response.body as { id: string; readiness: unknown }[]).map((task) => [
        task.id,
        task.readiness,
      ]),
    );
    expect(byId).toEqual({ T1: { reasons: [] }, T2: { reasons: BLOCKED_BY_T1 } });
  });

  it('one task comes with its reasons', async () => {
    await block();

    const response = await board.get(`${API}/tasks/T2`).expect(200);

    expect(() => routes['tasks.get'].response.schema.parse(response.body)).not.toThrow();
    expect((response.body as { readiness: unknown }).readiness).toEqual({
      reasons: BLOCKED_BY_T1,
    });
  });

  it('the task itself is still exactly taskSchema, with readiness beside it (INVARIANT)', async () => {
    await block();
    const { readiness, ...task } = (await getTask('T2')) as Record<string, unknown>;

    expect(readiness).toBeDefined();
    expect('readiness' in taskSchema.shape).toBe(false);
    expect(() => taskSchema.parse(task)).not.toThrow();
    // taskSchema is strict: readiness can never pass for a field of the task.
    expect(taskSchema.safeParse({ ...task, readiness }).success).toBe(false);
  });

  it('is never stored, never written by a PATCH, and the answers of writes do not carry it', async () => {
    await block();
    const file = await readFile(join(board.root, '.board', 'tasks', 'T2', 'task.md'), 'utf8');
    expect(file).not.toContain('readiness');

    const patched = await board.patch(`${API}/tasks/T2`, { title: 'Renamed' }).expect(200);
    expect(patched.body).not.toHaveProperty('readiness');
    expect(() => taskSchema.parse(patched.body)).not.toThrow();

    const refused = await board.patch(`${API}/tasks/T2`, { readiness: { reasons: [] } });
    expect(refused.status).toBe(400);
  });
});
