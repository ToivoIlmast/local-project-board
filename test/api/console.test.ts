import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  API_BASE_PATH as API,
  consoleEntrySchema,
  consoleEventsResponse,
  consoleReadResponse,
  errorResponseSchema,
  generateInstructions,
} from '../../src/contract/v1/index.js';
import { foldConsole } from '../../src/core/rules/console.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { cleanTmpDirs } from '../support/tmp.js';

/**
 * The server side of Console mode (plan C7): the runner's batches in, the journal and its
 * computed state out. The routes are the runner's and the page's, never an agent's.
 */

let board: TestBoard;
const boards: TestBoard[] = [];

async function open(root?: string): Promise<TestBoard> {
  const next = await createTestBoard(root === undefined ? {} : { root });
  boards.push(next);
  return next;
}

beforeEach(async () => {
  board = await open();
});

afterEach(async () => {
  await Promise.all(boards.splice(0).map((item) => item.close()));
  await cleanTmpDirs();
});

const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';
const OTHER_SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456790';
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const M3 = '33333333-3333-4333-8333-333333333333';

const code = (body: unknown): string => errorResponseSchema.parse(body).error.code;

const started = { kind: 'process.started', pid: 4242 };
const compat = { kind: 'compat.passed' };
const exited = { kind: 'process.exited', exitCode: 0, signal: null, lastTurnOpen: false };
const message = (messageId: string) => ({
  kind: 'user.message',
  origin: 'board',
  messageId,
  text: `text of ${messageId.slice(0, 2)}`,
});
const lifecycle = (messageId: string, state: string) => ({
  kind: 'user.lifecycle',
  messageId,
  state,
});

async function createTask(): Promise<string> {
  const response = await board.post(`${API}/tasks`, { title: 'Ship it' }).expect(201);
  return (response.body as { id: string }).id;
}

async function begin(id: string, over: Record<string, unknown> = {}) {
  const response = await board
    .post(`${API}/tasks/${id}/ai-run`, { sessionId: SESSION, mode: 'new', console: true, ...over })
    .expect(200);
  return response.body as { runId: number; console?: true };
}

/** A task with a console run 1 in session SESSION. */
async function consoleRun(): Promise<string> {
  const id = await createTask();
  await begin(id);
  return id;
}

function send(
  id: string,
  fromRunnerSeq: number,
  events: unknown[],
  over: { runId?: number; sessionId?: string | null } = {},
) {
  const sessionId = over.sessionId === undefined ? SESSION : over.sessionId;
  const query = sessionId === null ? '' : `?sessionId=${sessionId}`;
  return board.post(`${API}/tasks/${id}/ai-run/${over.runId ?? 1}/console/events${query}`, {
    fromRunnerSeq,
    events,
  });
}

function read(id: string, query = '', runId = 1) {
  return board.get(`${API}/tasks/${id}/ai-run/${runId}/console${query}`);
}

async function journal(id: string, target: TestBoard = board) {
  const response = await target.get(`${API}/tasks/${id}/ai-run/1/console?limit=1000`).expect(200);
  return consoleReadResponse.parse(response.body);
}

const appended = (target: TestBoard = board) =>
  target.events.events.filter((event) => event.type === 'console.appended');

const journalFile = (id: string, runId = 1) =>
  join(board.root, '.board', 'console', `${id}-${runId}.ndjson`);

describe('begin of a console run', () => {
  it('records console: true in the run, and only when asked (INVARIANT)', async () => {
    const id = await createTask();
    const run = await begin(id);
    expect(run.console).toBe(true);

    const plain = await createTask();
    const other = await board
      .post(`${API}/tasks/${plain}/ai-run`, { sessionId: SESSION, mode: 'new' })
      .expect(200);
    expect(other.body).not.toHaveProperty('console');
  });

  it('refuses console: false, which would be a second way to say nothing', async () => {
    const id = await createTask();
    const response = await board
      .post(`${API}/tasks/${id}/ai-run`, { sessionId: SESSION, mode: 'new', console: false })
      .expect(400);
    expect(code(response.body)).toBe('INVALID_REQUEST');
  });

  it('keeps console: true through the report of the agent', async () => {
    const id = await consoleRun();
    const response = await board
      .patch(`${API}/tasks/${id}/ai-run/1/report`, { agent: 'claude-code', state: 'finished' })
      .expect(200);
    expect((response.body as { aiRun: { console?: true } }).aiRun.console).toBe(true);
  });
});

describe('POST .../console/events', () => {
  it('requires the session token (INVARIANT)', async () => {
    const id = await consoleRun();
    const response = await board
      .agent()
      .post(`${API}/tasks/${id}/ai-run/1/console/events?sessionId=${SESSION}`)
      .send({ fromRunnerSeq: 1, events: [started] })
      .expect(401);
    expect(code(response.body)).toBe('UNAUTHORIZED');
  });

  it('writes the events and answers the cursor and the messages awaiting delivery', async () => {
    const id = await consoleRun();
    const response = await send(id, 1, [started, compat]).expect(200);
    expect(consoleEventsResponse.parse(response.body)).toEqual({
      lastRunnerSeq: 2,
      awaitingDelivery: 0,
    });
    const { entries } = await journal(id);
    expect(entries.map((entry) => [entry.seq, entry.runnerSeq, entry.source])).toEqual([
      [1, 1, 'runner'],
      [2, 2, 'runner'],
    ]);
    for (const entry of entries) expect(consoleEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('refuses an event the contract does not know, a long batch and a missing session', async () => {
    const id = await consoleRun();
    await send(id, 1, [{ kind: 'nope' }]).expect(400);
    await send(
      id,
      1,
      Array.from({ length: 51 }, () => compat),
    ).expect(400);
    const response = await send(id, 1, [started], { sessionId: null }).expect(400);
    expect(code(response.body)).toBe('INVALID_REQUEST');
    expect((await journal(id)).entries).toEqual([]);
    expect(appended()).toEqual([]);
  });

  describe('compare-and-set (INVARIANT)', () => {
    async function expectRefused(id: string, over: Parameters<typeof send>[3]) {
      const response = await send(id, 1, [started], over).expect(409);
      expect(code(response.body)).toBe('STALE_AI_RUN');
      await expect(stat(journalFile(id))).rejects.toThrow();
      expect(appended()).toEqual([]);
    }

    it('refuses a run that is not the current one', async () => {
      const id = await consoleRun();
      await expectRefused(id, { runId: 2 });
    });

    it('refuses another session', async () => {
      const id = await consoleRun();
      await expectRefused(id, { sessionId: OTHER_SESSION });
    });

    it('refuses a run that is not a console run', async () => {
      const id = await createTask();
      await begin(id, { console: undefined });
      await expectRefused(id, {});
    });

    it('refuses a task that has no run', async () => {
      const id = await createTask();
      await expectRefused(id, {});
    });

    it('leaves a journal that was written as it was', async () => {
      const id = await consoleRun();
      await send(id, 1, [started]).expect(200);
      const before = await readFile(journalFile(id), 'utf8');
      const count = appended().length;
      await send(id, 2, [compat], { sessionId: OTHER_SESSION }).expect(409);
      await send(id, 2, [compat], { runId: 7 }).expect(409);
      expect(await readFile(journalFile(id), 'utf8')).toBe(before);
      expect(appended()).toHaveLength(count);
    });
  });

  it('takes a batch after the agent reported, while the process lives (INVARIANT)', async () => {
    const id = await consoleRun();
    await board
      .patch(`${API}/tasks/${id}/ai-run/1/report`, { agent: 'claude-code', state: 'finished' })
      .expect(200);
    await send(id, 1, [started]).expect(200);
    expect((await journal(id)).entries).toHaveLength(1);
  });

  describe('the cursor of the runner', () => {
    it('writes nothing for a batch that is sent again, and says so with no event (INVARIANT)', async () => {
      const id = await consoleRun();
      const batch = [
        started,
        compat,
        message(M1),
        lifecycle(M1, 'queued'),
        lifecycle(M1, 'started'),
      ];
      await send(id, 1, batch).expect(200);
      const before = await readFile(journalFile(id), 'utf8');
      const response = await send(id, 1, batch).expect(200);
      expect((response.body as { lastRunnerSeq: number }).lastRunnerSeq).toBe(5);
      expect(await readFile(journalFile(id), 'utf8')).toBe(before);
      expect(appended()).toHaveLength(1);
    });

    it('writes only what is new when a batch overlaps what was written', async () => {
      const id = await consoleRun();
      await send(id, 1, [started, compat, message(M1), message(M2), message(M3)]).expect(200);
      const response = await send(id, 4, [
        message(M2),
        message(M3),
        lifecycle(M1, 'queued'),
        lifecycle(M2, 'queued'),
      ]).expect(200);
      expect((response.body as { lastRunnerSeq: number }).lastRunnerSeq).toBe(7);
      const { entries } = await journal(id);
      expect(entries.map((entry) => [entry.seq, entry.runnerSeq])).toEqual([
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4],
        [5, 5],
        [6, 6],
        [7, 7],
      ]);
      expect(appended()).toHaveLength(2);
    });

    it('notes a gap once, before the event after it, and goes on', async () => {
      const id = await consoleRun();
      await send(id, 1, [started, compat, message(M1), message(M2), message(M3)]).expect(200);
      const response = await send(id, 8, [lifecycle(M1, 'queued'), lifecycle(M2, 'queued')]).expect(
        200,
      );
      expect((response.body as { lastRunnerSeq: number }).lastRunnerSeq).toBe(9);
      const { entries } = await journal(id);
      expect(entries.slice(5).map((entry) => [entry.seq, entry.source, entry.runnerSeq])).toEqual([
        [6, 'server', undefined],
        [7, 'runner', 8],
        [8, 'runner', 9],
      ]);
      expect(entries[5]!.event).toEqual({
        kind: 'notice',
        level: 'warning',
        code: 'events_missing',
        fromRunnerSeq: 6,
        toRunnerSeq: 7,
      });
    });

    it('finds the cursor in the journal after the server was started again', async () => {
      const id = await consoleRun();
      await send(id, 1, [started, compat, message(M1)]).expect(200);
      const second = await open(board.root);
      const response = await second
        .post(`${API}/tasks/${id}/ai-run/1/console/events?sessionId=${SESSION}`, {
          fromRunnerSeq: 1,
          events: [started, compat, message(M1)],
        })
        .expect(200);
      expect((response.body as { lastRunnerSeq: number }).lastRunnerSeq).toBe(3);
      expect((await journal(id, second)).entries).toHaveLength(3);
      expect(appended(second)).toEqual([]);
    });
  });

  describe('awaitingDelivery', () => {
    it('counts the messages still accepted after the batch', async () => {
      const id = await consoleRun();
      const first = await send(id, 1, [message(M1), message(M2)]).expect(200);
      expect((first.body as { awaitingDelivery: number }).awaitingDelivery).toBe(2);
      const second = await send(id, 3, [lifecycle(M1, 'queued')]).expect(200);
      expect((second.body as { awaitingDelivery: number }).awaitingDelivery).toBe(1);
    });

    it('answers the same for an empty batch and writes nothing (INVARIANT)', async () => {
      const id = await consoleRun();
      await send(id, 1, [message(M1), message(M2)]).expect(200);
      await send(id, 3, [lifecycle(M1, 'queued')]).expect(200);
      const count = appended().length;
      const before = await readFile(journalFile(id), 'utf8');
      const response = await send(id, 4, []).expect(200);
      expect(response.body).toEqual({ lastRunnerSeq: 3, awaitingDelivery: 1 });
      expect(await readFile(journalFile(id), 'utf8')).toBe(before);
      expect(appended()).toHaveLength(count);
    });

    it('answers an empty batch of a run that has no journal yet', async () => {
      const id = await consoleRun();
      const response = await send(id, 1, []).expect(200);
      expect(response.body).toEqual({ lastRunnerSeq: 0, awaitingDelivery: 0 });
      await expect(stat(journalFile(id))).rejects.toThrow();
    });
  });

  it('numbers the entries without a gap when requests come at once (INVARIANT)', async () => {
    const id = await consoleRun();
    const events = Array.from({ length: 10 }, (_, index) => ({
      kind: 'runner.stderr',
      text: `line ${index + 1}`,
    }));
    // Each batch is a longer prefix of the same events, in whatever order they are served.
    await Promise.all(
      events.map((_, index) => send(id, 1, events.slice(0, index + 1)).then((r) => r.status)),
    );
    const { entries } = await journal(id);
    expect(entries.map((entry) => entry.seq)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(entries.map((entry) => entry.runnerSeq)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
    expect(entries.map((entry) => (entry.event as { text: string }).text)).toEqual(
      events.map((event) => event.text),
    );
  });

  it('publishes one console.appended for each batch that wrote something (INVARIANT)', async () => {
    const id = await consoleRun();
    await send(id, 1, [started, compat]).expect(200);
    await send(id, 3, [message(M1)]).expect(200);
    await send(id, 1, [started, compat, message(M1)]).expect(200); // all written already
    await send(id, 4, []).expect(200);
    expect(appended()).toEqual([
      { type: 'console.appended', taskId: id, runId: 1, lastSeq: 2 },
      { type: 'console.appended', taskId: id, runId: 1, lastSeq: 3 },
    ]);
  });

  describe('the end of the process', () => {
    async function withMessages(id: string) {
      await send(id, 1, [
        started,
        compat,
        message(M1),
        message(M2),
        lifecycle(M2, 'queued'),
        message(M3),
        lifecycle(M3, 'queued'),
        lifecycle(M3, 'started'),
      ]).expect(200);
    }

    it('settles the messages when process.exited comes, in the same write (INVARIANT)', async () => {
      const id = await consoleRun();
      await withMessages(id);
      const response = await send(id, 9, [exited]).expect(200);
      // The cursor of the runner counts what the runner sent, not what the server added.
      expect(response.body).toEqual({ lastRunnerSeq: 9, awaitingDelivery: 0 });
      const { entries, state } = await journal(id);
      const settled = entries.slice(9);
      expect(settled.map((entry) => entry.source)).toEqual(['server', 'server', 'server']);
      expect(settled.map((entry) => entry.event)).toEqual([
        { kind: 'user.lifecycle', messageId: M1, state: 'undelivered', cause: 'exited' },
        { kind: 'user.lifecycle', messageId: M2, state: 'undelivered', cause: 'exited' },
        { kind: 'user.lifecycle', messageId: M3, state: 'interrupted', cause: 'exited' },
      ]);
      expect(entries.map((entry) => entry.seq)).toEqual(
        Array.from({ length: 12 }, (_, i) => i + 1),
      );
      expect(state.messages.map((item) => item.status)).toEqual([
        'undelivered',
        'undelivered',
        'interrupted',
      ]);
      expect(appended()).toHaveLength(2);
    });

    it('settles nothing twice when the exit is sent again', async () => {
      const id = await consoleRun();
      await withMessages(id);
      await send(id, 9, [exited]).expect(200);
      const before = await readFile(journalFile(id), 'utf8');
      await send(id, 9, [exited]).expect(200);
      expect(await readFile(journalFile(id), 'utf8')).toBe(before);
    });

    it('settles the messages when the run ends without a process.exited', async () => {
      const id = await consoleRun();
      await withMessages(id);
      await board
        .post(`${API}/tasks/${id}/ai-run/1/end`, { exitCode: 1, sessionId: SESSION })
        .expect(200);
      const { entries } = await journal(id);
      expect(entries.slice(8).map((entry) => [entry.source, entry.event])).toEqual([
        ['server', { kind: 'user.lifecycle', messageId: M1, state: 'undelivered', cause: 'ended' }],
        ['server', { kind: 'user.lifecycle', messageId: M2, state: 'undelivered', cause: 'ended' }],
        ['server', { kind: 'user.lifecycle', messageId: M3, state: 'interrupted', cause: 'ended' }],
      ]);
      expect(appended()).toHaveLength(2);
    });

    it('does not settle again at the end when process.exited did it already', async () => {
      const id = await consoleRun();
      await withMessages(id);
      await send(id, 9, [exited]).expect(200);
      const before = await readFile(journalFile(id), 'utf8');
      const count = appended().length;
      await board
        .post(`${API}/tasks/${id}/ai-run/1/end`, { exitCode: 0, sessionId: SESSION })
        .expect(200);
      expect(await readFile(journalFile(id), 'utf8')).toBe(before);
      expect(appended()).toHaveLength(count);
    });

    it('settles the messages of a run that is abandoned, as lost (INVARIANT)', async () => {
      const id = await consoleRun();
      await withMessages(id);
      await board
        .post(`${API}/tasks/${id}/ai-run/1/abandon`, {
          sessionId: SESSION,
          message: 'lost: no pid',
        })
        .expect(200);
      const { entries, state } = await journal(id);
      expect(entries.slice(8).map((entry) => entry.event)).toEqual([
        { kind: 'user.lifecycle', messageId: M1, state: 'undelivered', cause: 'lost' },
        { kind: 'user.lifecycle', messageId: M2, state: 'undelivered', cause: 'lost' },
        { kind: 'user.lifecycle', messageId: M3, state: 'interrupted', cause: 'lost' },
      ]);
      expect(state.process.status).toBe('lost');
      expect(appended()).toHaveLength(2);
      // A second abandon is refused as before, and writes nothing more.
      await board
        .post(`${API}/tasks/${id}/ai-run/1/abandon`, { sessionId: SESSION, message: 'again' })
        .expect(409);
      expect((await journal(id)).entries).toHaveLength(11);
    });

    it('leaves a run that is not a console run alone at its end and abandon', async () => {
      const id = await createTask();
      await begin(id, { console: undefined });
      await board.post(`${API}/tasks/${id}/ai-run/1/end`, { exitCode: 0 }).expect(200);
      await expect(stat(journalFile(id))).rejects.toThrow();
      expect(appended()).toEqual([]);
    });

    it('still takes the rest of a spool after the end, while the run is the current one', async () => {
      const id = await consoleRun();
      await send(id, 1, [started]).expect(200);
      await board
        .post(`${API}/tasks/${id}/ai-run/1/end`, { exitCode: 0, sessionId: SESSION })
        .expect(200);
      await send(id, 2, [exited]).expect(200);
      expect((await journal(id)).entries).toHaveLength(2);
    });
  });
});

describe('GET .../console', () => {
  async function seeded(count: number): Promise<string> {
    const id = await consoleRun();
    const events = Array.from({ length: count }, (_, index) => ({
      kind: 'runner.stderr',
      text: `line ${index + 1}`,
    }));
    await send(id, 1, events.slice(0, 50)).expect(200);
    if (count > 50) await send(id, 51, events.slice(50)).expect(200);
    return id;
  }

  const seqs = (body: unknown) => consoleReadResponse.parse(body).entries.map((entry) => entry.seq);

  it('needs no token, as every read', async () => {
    const id = await seeded(1);
    await board.agent().get(`${API}/tasks/${id}/ai-run/1/console`).expect(200);
  });

  it('answers the entries and the state that foldConsole computes from the whole journal (INVARIANT)', async () => {
    const id = await consoleRun();
    await send(id, 1, [started, compat, message(M1), lifecycle(M1, 'queued')]).expect(200);
    const response = await read(id, '?after=2&limit=1').expect(200);
    const body = consoleReadResponse.parse(response.body);
    expect(body.entries.map((entry) => entry.seq)).toEqual([3]);
    // The state is of the whole journal, not of the page.
    const all = (await journal(id)).entries;
    expect(body.state).toEqual(JSON.parse(JSON.stringify(foldConsole(all))));
    expect(body.state.messages[0]!.status).toBe('queued');
    expect(body.state.compat.status).toBe('compatible');
  });

  it('reads after a seq, before a seq, and at most limit entries', async () => {
    const id = await seeded(10);
    expect(seqs((await read(id).expect(200)).body)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(seqs((await read(id, '?after=7').expect(200)).body)).toEqual([8, 9, 10]);
    expect(seqs((await read(id, '?after=2&limit=3').expect(200)).body)).toEqual([3, 4, 5]);
    // Before, the last ones that precede it: the way back through a long journal.
    expect(seqs((await read(id, '?before=8&limit=3').expect(200)).body)).toEqual([5, 6, 7]);
    expect(seqs((await read(id, '?after=2&before=6').expect(200)).body)).toEqual([3, 4, 5]);
    expect(seqs((await read(id, '?after=10').expect(200)).body)).toEqual([]);
  });

  it('refuses a limit and a cursor that are not numbers in range', async () => {
    const id = await seeded(1);
    for (const query of ['?limit=0', '?limit=1001', '?limit=x', '?after=-1', '?before=x', '?x=1']) {
      const response = await read(id, query).expect(400);
      expect(code(response.body)).toBe('INVALID_REQUEST');
    }
  });

  it('answers an empty journal of a run that has not sent anything yet', async () => {
    const id = await consoleRun();
    const body = consoleReadResponse.parse((await read(id).expect(200)).body);
    expect(body.entries).toEqual([]);
    expect(body.state.phase).toBe('starting');
  });

  it('refuses a run that does not exist or is not a console run', async () => {
    const id = await consoleRun();
    expect(code((await read(id, '', 5).expect(409)).body)).toBe('STALE_AI_RUN');
    const plain = await createTask();
    await begin(plain, { console: undefined });
    expect(code((await read(plain).expect(409)).body)).toBe('STALE_AI_RUN');
    expect(code((await board.get(`${API}/tasks/T99/ai-run/1/console`).expect(404)).body)).toBe(
      'TASK_NOT_FOUND',
    );
  });

  it('reads the journal of a run that is over, as long as the task keeps it in its history', async () => {
    const id = await consoleRun();
    await send(id, 1, [started]).expect(200);
    await board
      .post(`${API}/tasks/${id}/ai-run/1/end`, { exitCode: 0, sessionId: SESSION })
      .expect(200);
    await begin(id, { sessionId: OTHER_SESSION, console: undefined });
    expect((await journal(id)).entries).toHaveLength(1);
  });
});

describe('a server started again on the same directory', () => {
  it('answers the same journal and the same state (INVARIANT)', async () => {
    const id = await consoleRun();
    await send(id, 1, [started, compat, message(M1), message(M2), lifecycle(M2, 'queued')]).expect(
      200,
    );
    await send(id, 6, [exited]).expect(200);
    const before = await journal(id);
    const second = await open(board.root);
    const after = await journal(id, second);
    expect(after).toEqual(before);
    expect(after.state.process.status).toBe('exited');
  });
});

describe('the instructions of agents (INVARIANT)', () => {
  it('do not mention the console routes', () => {
    const instructions = generateInstructions({
      baseUrl: 'http://127.0.0.1:7432/api/v1',
      board: { name: 'board', statuses: ['backlog', 'done'], idPrefix: 'T' },
    });
    expect(instructions).not.toContain('/console');
    expect(instructions).not.toContain('console.appended');
  });
});
