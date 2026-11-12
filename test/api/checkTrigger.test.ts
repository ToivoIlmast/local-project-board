import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  API_BASE_PATH as API,
  checkSummarySchema,
  errorResponseSchema,
  routes,
  runRequestSchema,
  type RunRequest,
} from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { openStream, type SseClient } from '../support/sse.js';
import { cleanTmpDirs } from '../support/tmp.js';

/**
 * The trigger of an actuality check, from `/run` to the check summary (T98, ADR-0029 amendment
 * T95, V1–V5, ADR-0030 V1–V2): handed only to a runner that declared it, copied into begin
 * unchanged, and shown by the summary as the server read it from the record.
 */

let board: TestBoard;
const open: SseClient<RunRequest>[] = [];
const RUNS = `${API}${routes['runs.stream'].path}`;
const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';

beforeEach(async () => {
  board = await createTestBoard();
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  await board.close();
  await cleanTmpDirs();
});

const code = (body: unknown): string => errorResponseSchema.parse(body).error.code;
const message = (body: unknown): string => errorResponseSchema.parse(body).error.message;

/** A runner as the CLI is one; what it sees is not parsed, as an earlier runner would not. */
async function runner(accepts?: string): Promise<SseClient<RunRequest>> {
  const client = await openStream(
    board.port,
    accepts === undefined ? RUNS : `${RUNS}?accepts=${accepts}`,
    { authorization: `Bearer ${board.token}` },
    (data) => data as RunRequest,
  );
  open.push(client);
  return client;
}

async function createTask(over: object = {}): Promise<{ id: string }> {
  const response = await board.post(`${API}/tasks`, { title: 'A task', ...over }).expect(201);
  return response.body as { id: string };
}

/** The source task: done, so that it has a `doneAt`. */
async function doneTask(): Promise<{ id: string; doneAt: string }> {
  const task = await createTask();
  const done = await board.patch(`${API}/tasks/${task.id}`, { status: 'done' }).expect(200);
  const { doneAt } = done.body as { doneAt?: string };
  expect(doneAt).toEqual(expect.any(String));
  return { id: task.id, doneAt: doneAt as string };
}

const run = (id: string, body: object) =>
  board.post(`${API}/tasks/${id}/run`, { agent: 'claude-code', ...body });

const trigger = (source: { id: string; doneAt: string }, over: object = {}) => ({
  reason: 'task-done',
  task: source.id,
  doneAt: source.doneAt,
  ...over,
});

const checksDir = (id: string): Promise<string[]> =>
  readdir(join(board.root, '.board', 'tasks', id, 'history', 'checks')).catch(() => []);

describe('POST /tasks/:id/run with a trigger (ADR-0029 T95)', () => {
  it('without a trigger a check is handed as before: no trigger field, to any runner that accepts check (INVARIANT)', async () => {
    const target = await createTask();
    const old = await runner('check,research');
    await run(target.id, { kind: 'check' }).expect(200);
    await old.waitForEvents(1);
    expect(old.events).toEqual([
      { type: 'run.requested', taskId: target.id, agent: 'claude-code', kind: 'check' },
    ]);
    expect(Object.keys(old.events[0] ?? {})).not.toContain('trigger');
  });

  it('hands the trigger, unchanged, to a runner that declared it (V3)', async () => {
    const source = await doneTask();
    const target = await createTask();
    const able = await runner('check,research,trigger');
    const sent = trigger(source, { commit: 'abc1234' });
    const answer = await run(target.id, { kind: 'check', trigger: sent }).expect(200);
    expect(() => routes['tasks.run'].response.schema.parse(answer.body)).not.toThrow();
    await able.waitForEvents(1);
    expect(able.events).toEqual([
      {
        type: 'run.requested',
        taskId: target.id,
        agent: 'claude-code',
        kind: 'check',
        trigger: sent,
      },
    ]);
    expect(() => runRequestSchema.parse(able.events[0])).not.toThrow();
  });

  it('a trigger without a commit is a trigger: commit is optional', async () => {
    const source = await doneTask();
    const target = await createTask();
    const able = await runner('check,trigger');
    await run(target.id, { kind: 'check', trigger: trigger(source) }).expect(200);
    await able.waitForEvents(1);
    expect(able.events[0]?.trigger).toEqual(trigger(source));
  });

  it('refuses a trigger on a research, a work run or no kind, before a runner is asked (400)', async () => {
    const source = await doneTask();
    const target = await createTask();
    const able = await runner('check,research,trigger');
    for (const body of [{ kind: 'research' }, { kind: 'work' }, {}]) {
      const answer = await run(target.id, { ...body, trigger: trigger(source) }).expect(400);
      expect(code(answer.body)).toBe('INVALID_REQUEST');
    }
    expect(able.events).toEqual([]);
    expect(able.ended()).toBe(false);
  });

  it.each([
    ['no task', { task: undefined }],
    ['no doneAt', { doneAt: undefined }],
    ['another reason', { reason: 'manual' }],
    ['a commit that is not a SHA', { commit: 'main' }],
    ['another field', { transcript: 'text' }],
  ])('refuses a trigger of the wrong form (%s), before a runner is asked', async (_name, over) => {
    const source = await doneTask();
    const target = await createTask();
    const able = await runner('check,trigger');
    const answer = await run(target.id, {
      kind: 'check',
      trigger: { ...trigger(source), ...over },
    }).expect(400);
    expect(code(answer.body)).toBe('INVALID_REQUEST');
    expect(able.events).toEqual([]);
  });

  it('refuses a trigger whose doneAt is not the current doneAt of its task, and asks nobody', async () => {
    const source = await doneTask();
    const target = await createTask();
    const able = await runner('check,research,trigger');
    const answer = await run(target.id, {
      kind: 'check',
      trigger: trigger(source, { doneAt: '2000-01-01T00:00:00.000Z' }),
    }).expect(400);
    expect(code(answer.body)).toBe('INVALID_REQUEST');
    // The task is not done any more: it has no doneAt, so no trigger is current.
    await board.patch(`${API}/tasks/${source.id}`, { status: 'todo' }).expect(200);
    await run(target.id, { kind: 'check', trigger: trigger(source) }).expect(400);
    expect(able.events).toEqual([]);
    expect(able.ended()).toBe(false);
  });

  it('refuses a trigger whose task does not exist', async () => {
    const target = await createTask();
    const answer = await run(target.id, {
      kind: 'check',
      trigger: { reason: 'task-done', task: 'T999', doneAt: '2026-11-06T10:00:00.000Z' },
    }).expect(400);
    expect(code(answer.body)).toBe('INVALID_REQUEST');
  });

  it('with only earlier runners: 409 NO_AGENT_RUNNER (outdated), nothing handed, nothing written (V5)', async () => {
    const source = await doneTask();
    const target = await createTask();
    const withoutAccepts = await runner();
    const withoutTrigger = await runner('check,research');
    const answer = await run(target.id, { kind: 'check', trigger: trigger(source) }).expect(409);
    expect(code(answer.body)).toBe('NO_AGENT_RUNNER');
    expect(message(answer.body)).toMatch(/update/i);
    expect(withoutAccepts.events).toEqual([]);
    expect(withoutTrigger.events).toEqual([]);
    expect(withoutAccepts.ended()).toBe(false);
    expect(withoutTrigger.ended()).toBe(false);
    expect(await checksDir(target.id)).toEqual([]);
    // The runners still wait for a check without a trigger.
    await run(target.id, { kind: 'check' }).expect(200);
    await withoutTrigger.waitForEvents(1);
    expect(withoutTrigger.events[0]).not.toHaveProperty('trigger');
  });

  it('with no runner at all: the existing 409 NO_AGENT_RUNNER', async () => {
    const source = await doneTask();
    const target = await createTask();
    const answer = await run(target.id, { kind: 'check', trigger: trigger(source) }).expect(409);
    expect(code(answer.body)).toBe('NO_AGENT_RUNNER');
    expect(message(answer.body)).not.toMatch(/update/i);
  });

  it('passes over a runner without trigger for one that has it (V3, INVARIANT)', async () => {
    const source = await doneTask();
    const target = await createTask();
    const able = await runner('check,research,trigger');
    const old = await runner('check,research');
    await run(target.id, { kind: 'check', trigger: trigger(source) }).expect(200);
    await able.waitForEvents(1);
    expect(able.events[0]?.trigger).toEqual(trigger(source));
    expect(old.events).toEqual([]);
    expect(old.ended()).toBe(false);
  });

  it('a runner that declared trigger only, not check, is not handed a check', async () => {
    const source = await doneTask();
    const target = await createTask();
    const odd = await runner('trigger');
    await run(target.id, { kind: 'check', trigger: trigger(source) }).expect(409);
    expect(odd.events).toEqual([]);
  });
});

describe('GET /runs?accepts with trigger (V1)', () => {
  it('takes trigger in the closed list, and still refuses anything else', async () => {
    for (const accepts of ['check,research,trigger', 'trigger', 'check,trigger']) {
      expect((await runner(accepts)).ended()).toBe(false);
    }
    for (const accepts of ['trigger,', 'triggers', 'work,trigger']) {
      await board
        .agent()
        .get(`${RUNS}?accepts=${accepts}`)
        .set({ authorization: `Bearer ${board.token}` })
        .expect(400);
    }
  });
});

describe('POST /tasks/:id/checks with a trigger, and the summary (ADR-0030 V2)', () => {
  const begin = (id: string, body: object = {}) =>
    board.post(`${API}/tasks/${id}/checks`, { agent: 'claude-code', sessionId: SESSION, ...body });

  it('stores the trigger in the begin and shows it, whole, in the summary', async () => {
    const source = await doneTask();
    const target = await createTask();
    const sent = trigger(source, { commit: 'abc1234def' });
    await begin(target.id, { trigger: sent }).expect(200);
    const list = await board.get(`${API}/tasks/${target.id}/checks`).expect(200);
    const [summary] = (list.body as unknown[]).map((item) => checkSummarySchema.parse(item));
    expect(summary?.trigger).toEqual(sent);
    const check = await board.get(`${API}/tasks/${target.id}/checks/1`).expect(200);
    expect((check.body as { begin: { trigger: unknown } }).begin.trigger).toEqual(sent);
  });

  it('a check without a trigger has no trigger field anywhere', async () => {
    const target = await createTask();
    await begin(target.id).expect(200);
    const list = await board.get(`${API}/tasks/${target.id}/checks`).expect(200);
    expect(Object.keys((list.body as object[])[0] ?? {})).not.toContain('trigger');
  });

  it('refuses a trigger on a research begin, and writes nothing', async () => {
    const source = await doneTask();
    const target = await createTask();
    const answer = await begin(target.id, { kind: 'research', trigger: trigger(source) }).expect(
      400,
    );
    expect(code(answer.body)).toBe('INVALID_REQUEST');
    expect(await checksDir(target.id)).toEqual([]);
  });

  it('refuses a trigger of the wrong form, and writes nothing', async () => {
    const target = await createTask();
    for (const bad of [
      { reason: 'task-done', task: 'T1' },
      { reason: 'task-done', doneAt: '2026-11-06T10:00:00.000Z' },
      { reason: 'task-done', task: 'T1', doneAt: '2026-11-06T10:00:00.000Z', token: 'x' },
    ]) {
      await begin(target.id, { trigger: bad }).expect(400);
    }
    expect(await checksDir(target.id)).toEqual([]);
  });
});

describe('GET /tasks/:id/checks/:n/handoff of a triggered check (T99)', () => {
  const begin = (id: string, body: object = {}) =>
    board.post(`${API}/tasks/${id}/checks`, { agent: 'claude-code', sessionId: SESSION, ...body });
  const handoff = async (id: string): Promise<string> =>
    (await board.get(`${API}/tasks/${id}/checks/1/handoff`).expect(200)).text;

  it('links the done task, its report and its commit, and copies none of their text (INVARIANT)', async () => {
    const source = await createTask({ title: 'SourceTitleMarker', body: 'SourceBodyMarker' });
    await board
      .put(`${API}/tasks/${source.id}/documents/report.md`, { content: 'ReportTextMarker' })
      .expect(200);
    const done = (await board.patch(`${API}/tasks/${source.id}`, { status: 'done' }).expect(200))
      .body as { doneAt: string };
    const target = await createTask();
    await begin(target.id, {
      trigger: trigger({ id: source.id, doneAt: done.doneAt }, { commit: 'abc1234def' }),
    }).expect(200);
    const text = await handoff(target.id);
    expect(text).toContain('## Why this check');
    expect(text).toContain(`${API}/tasks/${source.id}/documents/report.md`);
    expect(text).toContain('git show abc1234def');
    for (const marker of ['SourceTitleMarker', 'SourceBodyMarker', 'ReportTextMarker']) {
      expect(text).not.toContain(marker);
    }
    expect(text).not.toContain(board.token);
  });

  it('a check without a trigger has the handoff it always had', async () => {
    const target = await createTask();
    await begin(target.id).expect(200);
    const text = await handoff(target.id);
    expect(text).not.toContain('## Why this check');
    expect(text).not.toContain('## Topic context');
  });
});
