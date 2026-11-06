import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  API_BASE_PATH as API,
  claudeModelSchema,
  errorResponseSchema,
  routes,
  runFailureResponseSchema,
  runRequestSchema,
  taskSchema,
  taskIdSchema,
  versionListSchema,
  type RunRequest,
  type Task,
} from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { openStream, type SseClient } from '../support/sse.js';
import { cleanTmpDirs } from '../support/tmp.js';

/**
 * A work run that was handed to a runner and did not begin is seen on the board (ADR-0029 T94):
 * `/run` writes `launch` before the runner is told (K6), the runner's `run-failure` adds the
 * failure once to the current request (K8), and begin removes it (K5). Real server, real files,
 * real streams; the runner is the stream a runner waits on, and nothing more.
 */

let board: TestBoard;
const open: SseClient<unknown>[] = [];

const RUNS = `${API}${routes['runs.stream'].path}`;

/**
 * `run.requested` as a runner before T94 parses it: strict, without `requestId` (copied from the
 * contract at cd9e635). A field it does not know makes it drop the whole request (K11).
 */
const runRequestBeforeT94 = z
  .strictObject({
    type: z.literal('run.requested'),
    taskId: taskIdSchema,
    agent: z.literal('claude-code'),
    model: claudeModelSchema.optional(),
    mode: z.enum(['resume', 'restart']).optional(),
    kind: z.enum(['check', 'research']).optional(),
    comment: z.string().optional(),
  })
  .refine((request) => request.comment === undefined || request.kind === 'research');

beforeEach(async () => {
  board = await createTestBoard();
  for (const title of ['Ship it', 'Not this one']) {
    await board.post(`${API}/tasks`, { title, status: 'todo' }).expect(201);
  }
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  await board.close();
  await cleanTmpDirs();
});

const code = (body: unknown): string => errorResponseSchema.parse(body).error.code;

/** A runner of this version: it declares `signals=run-failure` and reads `requestId`. */
async function runner(query = '?signals=run-failure'): Promise<SseClient<RunRequest>> {
  const client = await openStream(
    board.port,
    `${RUNS}${query}`,
    { authorization: `Bearer ${board.token}` },
    (data) => runRequestSchema.parse(data),
  );
  open.push(client as SseClient<unknown>);
  return client;
}

/** A runner of an earlier version: no `signals`, and the strict schema it had. */
async function earlierRunner(query = ''): Promise<SseClient<unknown>> {
  const client = await openStream(
    board.port,
    `${RUNS}${query}`,
    { authorization: `Bearer ${board.token}` },
    (data) => data,
  );
  open.push(client);
  return client;
}

const start = (id: string, body: unknown = { agent: 'claude-code' }) =>
  board.post(`${API}/tasks/${id}/run`, body);

const report = (id: string, body: unknown) => board.post(`${API}/tasks/${id}/run-failure`, body);

const getTask = async (id: string): Promise<Task> =>
  taskSchema.parse(
    (({ readiness: _r, ...task }) => task)(
      (await board.get(`${API}/tasks/${id}`).expect(200)).body as Task & { readiness: unknown },
    ),
  );

const taskFile = (id: string): Promise<string> =>
  readFile(join(board.root, '.board', 'tasks', id, 'task.md'), 'utf8');

/** Hands T1 to a runner of this version and answers with the request id it was given. */
async function handed(id = 'T1'): Promise<string> {
  const waiting = await runner();
  await start(id).expect(200);
  const [event] = await waiting.waitForEvents(1);
  if (event?.requestId === undefined) throw new Error('No requestId was handed.');
  return event.requestId;
}

describe('POST /tasks/:id/run of a work run writes launch (K2, K3, K6)', () => {
  it('hands a new runner the requestId that is already on disk when the runner reads it (INVARIANT I1)', async () => {
    const waiting = await runner();

    const answer = await start('T1').expect(200);

    // The answer of /run is unchanged: a page of an earlier board parses it strictly (K2).
    expect(answer.body).toEqual({ taskId: 'T1', agent: 'claude-code' });
    const [event] = await waiting.waitForEvents(1);
    expect(event).toEqual({
      type: 'run.requested',
      taskId: 'T1',
      agent: 'claude-code',
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    // The runner holds the request only now; the file had it before the stream carried it.
    const file = await taskFile('T1');
    expect(file).toContain(`requestId: ${event?.requestId}`);
    expect((await getTask('T1')).launch).toEqual({
      requestId: event?.requestId,
      requestedAt: expect.any(String),
      afterRunId: 0,
      reports: true,
    });
  });

  it('makes a new UUID for every request (K2)', async () => {
    const ids = new Set<string>();
    for (let n = 0; n < 5; n += 1) ids.add(await handed('T1'));
    expect(ids.size).toBe(5);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
  });

  it('takes no requestId from the body: the board makes it (K2)', async () => {
    await runner();
    const answer = await start('T1', { agent: 'claude-code', requestId: randomUUID() });
    expect(answer.status).toBe(400);
    expect((await getTask('T1')).launch).toBeUndefined();
  });

  it('binds the request to its task: the other task has no launch', async () => {
    const requestId = await handed('T2');
    expect((await getTask('T2')).launch?.requestId).toBe(requestId);
    expect((await getTask('T1')).launch).toBeUndefined();
  });

  it('leaves the file as it was when no runner waits (INVARIANT I3)', async () => {
    const before = await taskFile('T1');
    const published = board.events.events.length;

    const answer = await start('T1').expect(409);

    expect(code(answer.body)).toBe('NO_AGENT_RUNNER');
    expect(await taskFile('T1')).toBe(before);
    expect(board.events.events).toHaveLength(published);
  });

  it('two tasks, one runner: one is handed and has a launch, the other is refused and has none (I4)', async () => {
    const waiting = await runner();

    const answers = await Promise.all([start('T1'), start('T2')]);

    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    const [event] = await waiting.waitForEvents(1);
    const launches = [(await getTask('T1')).launch, (await getTask('T2')).launch];
    expect(launches.filter((launch) => launch !== undefined)).toEqual([
      expect.objectContaining({ requestId: event?.requestId }),
    ]);
    expect(waiting.events).toHaveLength(1);
  });

  it('many tasks at once, two runners: each runner gets exactly one request (I4)', async () => {
    const first = await runner();
    const second = await runner();
    for (const title of ['Three', 'Four']) {
      await board.post(`${API}/tasks`, { title, status: 'todo' }).expect(201);
    }

    const answers = await Promise.all(['T1', 'T2', 'T3', 'T4'].map((id) => start(id)));

    expect(answers.filter((answer) => answer.status === 200)).toHaveLength(2);
    await first.waitForEvents(1);
    await second.waitForEvents(1);
    const handedIds = [...first.events, ...second.events].map((event) => event.taskId);
    expect(new Set(handedIds).size).toBe(2);
    for (const id of ['T1', 'T2', 'T3', 'T4']) {
      expect((await getTask(id)).launch !== undefined).toBe(handedIds.includes(id));
    }
  });

  it('writes one launch and one task.updated, and nothing else of the task (K5)', async () => {
    const before = await getTask('T1');
    const published = board.events.events.length;

    await handed('T1');

    const after = await getTask('T1');
    const { launch, updatedAt: _u, ...rest } = after;
    const { updatedAt: _b, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
    expect(launch).toBeDefined();
    expect(board.events.events.slice(published)).toEqual([
      { type: 'task.updated', task: expect.objectContaining({ launch }) },
    ]);
  });

  it('makes no version, and leaves the content hash as it was (K3, ADR-0030 §1)', async () => {
    const before = versionListSchema.parse(
      (await board.get(`${API}/tasks/T1/versions`).expect(200)).body,
    );
    const requestId = await handed('T1');
    await report('T1', { requestId, kind: 'claude-missing', message: 'gone' }).expect(200);

    const after = versionListSchema.parse(
      (await board.get(`${API}/tasks/T1/versions`).expect(200)).body,
    );
    expect(after).toEqual(before);
  });

  it('cannot be written through PATCH: the body is strict (K3)', async () => {
    const launch = {
      requestId: randomUUID(),
      requestedAt: new Date().toISOString(),
      afterRunId: 0,
      reports: true,
    };
    const answer = await board.patch(`${API}/tasks/T1`, { launch });
    expect(answer.status).toBe(400);
    expect((await getTask('T1')).launch).toBeUndefined();
  });

  it('is not given to agents: the handoff does not carry the request (K3)', async () => {
    const requestId = await handed('T1');
    const handoff = await board.get(`${API}/tasks/T1/handoff`).expect(200);
    expect(handoff.text).not.toContain(requestId);
    expect(handoff.text).not.toContain('launch');
  });

  it('is not written for a check or a research, and they carry no requestId (K1)', async () => {
    const waiting = await runner('?accepts=check,research&signals=run-failure');
    await start('T1', { agent: 'claude-code', kind: 'check' }).expect(200);
    const [event] = await waiting.waitForEvents(1);
    expect(event).toEqual({
      type: 'run.requested',
      taskId: 'T1',
      agent: 'claude-code',
      kind: 'check',
    });

    const researcher = await runner('?accepts=research&signals=run-failure');
    await start('T2', { agent: 'claude-code', kind: 'research', comment: 'Why?' }).expect(200);
    const [research] = await researcher.waitForEvents(1);
    expect(research).not.toHaveProperty('requestId');

    expect((await getTask('T1')).launch).toBeUndefined();
    expect((await getTask('T2')).launch).toBeUndefined();
  });

  it('survives a restart of the board on the same .board/, and the new board takes the report (K3, K9)', async () => {
    const requestId = await handed('T1');
    const root = board.root;
    await board.close();

    board = await createTestBoard({ root });

    expect((await getTask('T1')).launch?.requestId).toBe(requestId);
    const answer = await report('T1', { requestId, kind: 'runner-error' }).expect(200);
    expect(answer.body).toMatchObject({ recorded: true });
  });
});

describe('a runner of an earlier version (K11)', () => {
  it('gets exactly the event it knows, and launch says reports: false (INVARIANT)', async () => {
    const waiting = await earlierRunner();

    await start('T1', { agent: 'claude-code', model: 'sonnet' }).expect(200);

    const [event] = await waiting.waitForEvents(1);
    expect(event).toEqual({
      type: 'run.requested',
      taskId: 'T1',
      agent: 'claude-code',
      model: 'sonnet',
    });
    expect(runRequestBeforeT94.safeParse(event).success).toBe(true);
    expect((await getTask('T1')).launch).toMatchObject({ afterRunId: 0, reports: false });
  });

  it('with accepts but no signals is still an earlier runner', async () => {
    const waiting = await earlierRunner('?accepts=check,research');
    await start('T1', { agent: 'claude-code', mode: undefined }).expect(200);
    const [event] = await waiting.waitForEvents(1);
    expect(runRequestBeforeT94.safeParse(event).success).toBe(true);
    expect((await getTask('T1')).launch?.reports).toBe(false);
  });

  it('a runner of this version: the event has a requestId, which an earlier runner would drop', async () => {
    const waiting = await runner();
    await start('T1').expect(200);
    const [event] = await waiting.waitForEvents(1);
    // Why it is sent only to a runner that declared it: the earlier schema refuses it.
    expect(runRequestBeforeT94.safeParse(event).success).toBe(false);
  });

  it('refuses a signals list it does not know, as strictly as accepts', async () => {
    for (const query of ['?signals=', '?signals=run-start', '?signals=run-failure,other']) {
      const answer = await board
        .agent()
        .get(`${RUNS}${query}`)
        .set('Authorization', `Bearer ${board.token}`);
      expect(answer.status).toBe(400);
    }
  });
});

describe('POST /tasks/:id/run-failure (K8, K10, K16)', () => {
  it.each(['claude-missing', 'resume-refused', 'begin-refused', 'runner-error'] as const)(
    'records %s on the current request (INVARIANT)',
    async (kind) => {
      const requestId = await handed();

      const answer = await report('T1', { requestId, kind, message: 'Why it stopped.' }).expect(
        200,
      );

      const body = runFailureResponseSchema.parse(answer.body);
      expect(body.recorded).toBe(true);
      expect(body.launch.failure).toEqual({
        kind,
        message: 'Why it stopped.',
        at: expect.any(String),
      });
      expect((await getTask('T1')).launch).toEqual(body.launch);
      expect(() => routes['tasks.runFailure'].response.schema.parse(answer.body)).not.toThrow();
    },
  );

  it('needs the session token (ADR-0008)', async () => {
    const requestId = await handed();
    const body = { requestId, kind: 'runner-error' };

    const none = await board.agent().post(`${API}/tasks/T1/run-failure`).send(body);
    const wrong = await board
      .agent()
      .post(`${API}/tasks/T1/run-failure`)
      .set('Authorization', 'Bearer not-the-token')
      .send(body);

    expect(none.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(code(wrong.body)).toBe('UNAUTHORIZED');
    expect((await getTask('T1')).launch?.failure).toBeUndefined();
  });

  it('refuses a body that is not the contract: 400, and nothing is written', async () => {
    const requestId = await handed();
    for (const body of [
      {},
      { requestId: 'not-a-uuid', kind: 'runner-error' },
      { requestId, kind: 'exit' },
      { requestId },
      { requestId, kind: 'runner-error', message: 42 },
      { requestId, kind: 'runner-error', at: new Date().toISOString() },
      { requestId, kind: 'runner-error', message: 'x'.repeat(501) },
    ]) {
      const answer = await report('T1', body);
      expect([answer.status, code(answer.body)]).toEqual([400, 'INVALID_REQUEST']);
    }
    expect((await getTask('T1')).launch?.failure).toBeUndefined();
  });

  it('takes a message of exactly 500 characters', async () => {
    const requestId = await handed();
    const answer = await report('T1', {
      requestId,
      kind: 'runner-error',
      message: 'x'.repeat(500),
    });
    expect(answer.status).toBe(200);
    expect((await getTask('T1')).launch?.failure?.message).toHaveLength(500);
  });

  it('cleans the message: no token, no control characters, trimmed (K10, INVARIANT)', async () => {
    const requestId = await handed();
    const message = `  begin refused\nwith Bearer ${board.token}\u0000 and\ttabs\r\n `;

    const answer = await report('T1', { requestId, kind: 'begin-refused', message }).expect(200);

    const stored = (await getTask('T1')).launch?.failure?.message;
    expect(stored).toBe('begin refused with Bearer [token]  and tabs');
    expect(JSON.stringify(answer.body)).not.toContain(board.token);
    expect(await taskFile('T1')).not.toContain(board.token);
    expect(JSON.stringify(board.events.events)).not.toContain(board.token);
    expect(JSON.stringify(board.internalErrors)).not.toContain(board.token);
  });

  it('keeps no message when nothing is left of it', async () => {
    const requestId = await handed();
    await report('T1', { requestId, kind: 'runner-error', message: ' \n\t ' }).expect(200);
    expect((await getTask('T1')).launch?.failure).toEqual({
      kind: 'runner-error',
      at: expect.any(String),
    });
  });

  it('keeps the first report: a repeat, the same or not, is 200 recorded: false (INVARIANT)', async () => {
    const requestId = await handed();
    const first = await report('T1', { requestId, kind: 'claude-missing', message: 'A' }).expect(
      200,
    );
    const published = board.events.events.length;
    const file = await taskFile('T1');

    const same = await report('T1', { requestId, kind: 'claude-missing', message: 'A' }).expect(
      200,
    );
    const other = await report('T1', { requestId, kind: 'begin-refused', message: 'B' }).expect(
      200,
    );
    const bare = await report('T1', { requestId, kind: 'claude-missing' }).expect(200);

    for (const answer of [same, other, bare]) {
      expect(answer.body).toEqual({
        recorded: false,
        launch: (first.body as { launch: unknown }).launch,
      });
    }
    expect(await taskFile('T1')).toBe(file);
    expect(board.events.events).toHaveLength(published);
  });

  it('refuses an unknown requestId, without echoing the body (409 STALE_LAUNCH_REQUEST)', async () => {
    await handed();
    const stranger = randomUUID();

    const answer = await report('T1', {
      requestId: stranger,
      kind: 'runner-error',
      message: 'secret',
    });

    expect(answer.status).toBe(409);
    const error = errorResponseSchema.parse(answer.body).error;
    expect(error.code).toBe('STALE_LAUNCH_REQUEST');
    expect(error.details).toEqual({ id: 'T1' });
    expect(JSON.stringify(answer.body)).not.toContain(stranger);
    expect(JSON.stringify(answer.body)).not.toContain('secret');
  });

  it('refuses the report of an earlier request after a new one (K13)', async () => {
    const old = await handed();
    const current = await handed();

    const answer = await report('T1', { requestId: old, kind: 'claude-missing' });

    expect(code(answer.body)).toBe('STALE_LAUNCH_REQUEST');
    expect((await getTask('T1')).launch).toMatchObject({ requestId: current });
    expect((await getTask('T1')).launch?.failure).toBeUndefined();
  });

  it('refuses a report after begin: the run has begun, and begin removed the launch (K13, INVARIANT)', async () => {
    const requestId = await handed();
    const session = randomUUID();
    await board.post(`${API}/tasks/T1/ai-run`, { sessionId: session, mode: 'new' }).expect(200);
    const run = (await getTask('T1')).aiRun;

    const answer = await report('T1', { requestId, kind: 'begin-refused' });

    expect(code(answer.body)).toBe('STALE_LAUNCH_REQUEST');
    expect((await getTask('T1')).launch).toBeUndefined();
    expect((await getTask('T1')).aiRun).toEqual(run);
    expect(await taskFile('T1')).not.toContain('launch:');
  });

  it('refuses a task without a launch, and a task that does not exist', async () => {
    const body = { requestId: randomUUID(), kind: 'runner-error' };
    expect(code((await report('T1', body)).body)).toBe('STALE_LAUNCH_REQUEST');
    expect((await report('T9', body)).status).toBe(404);
  });

  it('many reports at once: one is recorded, all answer the one stored (atomic)', async () => {
    const requestId = await handed();
    const kinds = ['claude-missing', 'resume-refused', 'begin-refused', 'runner-error'] as const;

    const answers = await Promise.all(kinds.map((kind) => report('T1', { requestId, kind })));

    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200]);
    const bodies = answers.map((answer) => runFailureResponseSchema.parse(answer.body));
    expect(bodies.filter((body) => body.recorded)).toHaveLength(1);
    const stored = (await getTask('T1')).launch;
    for (const body of bodies) expect(body.launch).toEqual(stored);
  });

  it('begin and a report at once never leave a failure beside a working run (K13)', async () => {
    for (let round = 0; round < 5; round += 1) {
      const requestId = await handed();
      const session = randomUUID();
      const [begin, failure] = await Promise.all([
        board.post(`${API}/tasks/T1/ai-run`, { sessionId: session, mode: 'new' }),
        report('T1', { requestId, kind: 'begin-refused' }),
      ]);
      expect(begin.status).toBe(200);
      expect([200, 409]).toContain(failure.status);
      const task = await getTask('T1');
      expect(task.aiRun?.state).toBe('working');
      expect(task.launch).toBeUndefined();
      // End the run so that the next round can hand a request again.
      await board
        .post(`${API}/tasks/T1/ai-run/${task.aiRun?.runId}/end`, {
          exitCode: 1,
          sessionId: session,
        })
        .expect(200);
    }
  });

  it('is not in the instructions of an agent (K16)', async () => {
    const text = (await board.get(`${API}/instructions`).expect(200)).text;
    expect(text).not.toContain('run-failure');
  });
});
