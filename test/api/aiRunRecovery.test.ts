import {
  API_BASE_PATH as API,
  errorResponseSchema,
  generateInstructions,
  routes,
  runRequestSchema,
  type RunRequest,
} from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { openStream, type SseClient } from '../support/sse.js';
import { cleanTmpDirs } from '../support/tmp.js';

/**
 * A run whose runner died (T45): the board can be told that it is lost, but only for the run
 * the caller names exactly, and nothing else lets a task that works be started or cleared.
 */

let board: TestBoard;
const open: SseClient<RunRequest>[] = [];

const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';
const OTHER = '00000000-0000-4000-8000-000000000000';

beforeEach(async () => {
  board = await createTestBoard();
  await board.post(`${API}/tasks`, { title: 'Ship it', status: 'todo' }).expect(201);
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  await board.close();
  await cleanTmpDirs();
});

const code = (body: unknown): string => errorResponseSchema.parse(body).error.code;

async function runner(): Promise<SseClient<RunRequest>> {
  const client = await openStream(
    board.port,
    `${API}${routes['runs.stream'].path}`,
    { authorization: `Bearer ${board.token}` },
    (data) => runRequestSchema.parse(data),
  );
  open.push(client);
  return client;
}

const begin = () =>
  board.post(`${API}/tasks/T1/ai-run`, { sessionId: SESSION, mode: 'new' }).expect(200);
const abandon = (runId: number, body: unknown) =>
  board.post(`${API}/tasks/T1/ai-run/${runId}/abandon`, body);
const task = async () =>
  (await board.get(`${API}/tasks/T1`).expect(200)).body as Record<string, unknown>;

describe('POST /tasks/:id/run while a run works (T45)', () => {
  it.each([
    [{ agent: 'claude-code' }],
    [{ agent: 'claude-code', mode: 'new' }],
    [{ agent: 'claude-code', mode: 'resume' }],
  ])('%j: 409 AI_RUN_IN_PROGRESS, and the runner is not asked (INVARIANT)', async (body) => {
    // Mutation: check working only for resume → new reaches the runner → fails.
    await begin();
    const waiting = await runner();

    const response = await board.post(`${API}/tasks/T1/run`, body).expect(409);

    expect(code(response.body)).toBe('AI_RUN_IN_PROGRESS');
    expect(waiting.events).toEqual([]);
    expect(waiting.ended()).toBe(false);
  });
});

describe('POST /tasks/:id/ai-run/:runId/abandon (T45)', () => {
  it('requires the session token, and writes nothing without it (INVARIANT)', async () => {
    await begin();
    const before = await task();

    const response = await board
      .agent()
      .post(`${API}/tasks/T1/ai-run/1/abandon`)
      .send({ sessionId: SESSION, message: 'lost' })
      .expect(401);

    expect(code(response.body)).toBe('UNAUTHORIZED');
    expect(await task()).toEqual(before);
  });

  it('marks the named run failed{lost}, keeps runId and sessionId, and tells the open pages', async () => {
    await begin();

    const response = await abandon(1, { sessionId: SESSION, message: 'the runner is gone' }).expect(
      200,
    );

    expect(response.body).toMatchObject({
      state: 'failed',
      runId: 1,
      sessionId: SESSION,
      failure: { kind: 'lost', message: 'the runner is gone' },
    });
    expect((await task()).aiRun).toEqual(response.body);
    expect(board.events.events.at(-1)).toMatchObject({
      type: 'task.updated',
      task: { id: 'T1', aiRun: { failure: { kind: 'lost' } } },
    });
  });

  it('refuses a stale runId, a foreign session and a run that is over: 409, nothing written (INVARIANT)', async () => {
    await begin();
    const before = await task();

    expect(code((await abandon(2, { sessionId: SESSION, message: 'x' }).expect(409)).body)).toBe(
      'STALE_AI_RUN',
    );
    expect(code((await abandon(1, { sessionId: OTHER, message: 'x' }).expect(409)).body)).toBe(
      'STALE_AI_RUN',
    );
    expect(await task()).toEqual(before);

    await board
      .post(`${API}/tasks/T1/ai-run/1/end`, { exitCode: 1, sessionId: SESSION })
      .expect(200);
    const over = await task();
    expect(code((await abandon(1, { sessionId: SESSION, message: 'x' }).expect(409)).body)).toBe(
      'AI_RUN_ALREADY_FINAL',
    );
    expect(await task()).toEqual(over);
  });

  it('takes a session and a message and nothing else', async () => {
    await begin();
    for (const body of [
      {},
      { sessionId: SESSION },
      { message: 'x' },
      { sessionId: 'not-a-uuid', message: 'x' },
      { sessionId: SESSION, message: '' },
      { sessionId: SESSION, message: 'x', state: 'failed' },
    ]) {
      expect(code((await abandon(1, body).expect(400)).body)).toBe('INVALID_REQUEST');
    }
    expect((await task()).aiRun).toMatchObject({ state: 'working' });
  });

  it('is not given to agents: not in the instructions', () => {
    expect(routes['ai-run.abandon'].ai.include).toBe(false);
    const instructions = generateInstructions({
      baseUrl: 'http://127.0.0.1:7432/api/v1',
      board: { name: 'board', statuses: ['backlog', 'done'], idPrefix: 'T' },
    });
    expect(instructions).not.toContain('abandon');
  });
});

describe('end names its session (T45)', () => {
  it('an end with the session of another run: 409 STALE_AI_RUN, nothing written (INVARIANT)', async () => {
    await begin();
    const before = await task();

    const response = await board
      .post(`${API}/tasks/T1/ai-run/1/end`, { exitCode: 0, sessionId: OTHER })
      .expect(409);

    expect(code(response.body)).toBe('STALE_AI_RUN');
    expect(await task()).toEqual(before);
  });

  it('begin and end are published as task.updated (INVARIANT)', async () => {
    await begin();
    expect(board.events.events.at(-1)).toMatchObject({
      type: 'task.updated',
      task: { aiRun: { state: 'working' } },
    });
    await board
      .post(`${API}/tasks/T1/ai-run/1/end`, { exitCode: 2, sessionId: SESSION })
      .expect(200);
    expect(board.events.events.at(-1)).toMatchObject({
      type: 'task.updated',
      task: { aiRun: { state: 'failed', failure: { exitCode: 2 } } },
    });
  });
});

describe('PATCH aiRun: null (T45)', () => {
  const REPORT = {
    agent: 'claude-code',
    state: 'finished',
    checks: 'passed',
    finishedAt: '2026-09-26T11:00:00.000Z',
  };
  const states: [string, () => Promise<unknown>][] = [
    ['working', async () => begin()],
    [
      'finished',
      async () => {
        await begin();
        await board.patch(`${API}/tasks/T1/ai-run/1/report`, REPORT).expect(200);
      },
    ],
    [
      'failed',
      async () => {
        await begin();
        await board
          .post(`${API}/tasks/T1/ai-run/1/end`, { exitCode: 2, sessionId: SESSION })
          .expect(200);
      },
    ],
  ];

  it.each(states)(
    'a %s run with a runId is refused with 409 AI_RUN_NOT_CLEARABLE, and nothing changes (INVARIANT)',
    async (_state, setUp) => {
      // Mutation: allow null for a run with a runId → the run disappears, runId restarts → fails.
      await setUp();
      const before = await task();
      const published = board.events.events.length;

      for (const patch of [{ aiRun: null }, { aiRun: null, title: 'Renamed' }]) {
        const response = await board.patch(`${API}/tasks/T1`, patch).expect(409);
        expect(code(response.body)).toBe('AI_RUN_NOT_CLEARABLE');
      }

      expect(await task()).toEqual(before);
      expect(board.events.events.length).toBe(published);
    },
  );

  it.each(states.filter(([state]) => state !== 'working'))(
    'after a refused clear of a %s run, the next run takes the next runId (INVARIANT)',
    async (_state, setUp) => {
      await setUp();
      await board.patch(`${API}/tasks/T1`, { aiRun: null }).expect(409);

      await board
        .post(`${API}/tasks/T1/ai-run`, { sessionId: SESSION, mode: 'resume' })
        .expect(200);

      expect((await task())['aiRun']).toMatchObject({ runId: 2, state: 'working' });
    },
  );

  it.each(['working', 'finished', 'failed'] as const)(
    'a legacy %s run without a runId is still cleared (user cleanup, before T31)',
    async (state) => {
      await board.storage.updateTask('T1', {
        aiRun: { agent: 'claude-code', state, startedAt: '2026-09-20T10:00:00Z' },
      });

      const response = await board.patch(`${API}/tasks/T1`, { aiRun: null }).expect(200);

      expect(response.body).not.toHaveProperty('aiRun');
      expect(await task()).not.toHaveProperty('aiRun');
    },
  );
});
