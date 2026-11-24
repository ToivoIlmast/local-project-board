import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  API_BASE_PATH as API,
  consoleReadResponse,
  errorResponseSchema,
  generateInstructions,
} from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { cleanTmpDirs } from '../support/tmp.js';

/**
 * The page's side of Console mode (plan C10, §3.4, §8.3): a message is accepted into the journal
 * under the lock of the task, or refused and the journal stays as it was.
 */

let board: TestBoard;

beforeEach(async () => {
  board = await createTestBoard();
});

afterEach(async () => {
  await board.close();
  await cleanTmpDirs();
});

const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';
const OTHER_SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456790';
const M1 = '11111111-1111-4111-8111-111111111111';

const code = (body: unknown): string => errorResponseSchema.parse(body).error.code;

const started = { kind: 'process.started', pid: 4242 };
const compat = { kind: 'compat.passed' };
const exited = { kind: 'process.exited', exitCode: 0, signal: null, lastTurnOpen: false };

async function createTask(): Promise<string> {
  const response = await board.post(`${API}/tasks`, { title: 'Ship it' }).expect(201);
  return (response.body as { id: string }).id;
}

async function begin(id: string, over: Record<string, unknown> = {}) {
  const response = await board
    .post(`${API}/tasks/${id}/ai-run`, { sessionId: SESSION, mode: 'new', console: true, ...over })
    .expect(200);
  return response.body as { runId: number };
}

async function runner(id: string, from: number, events: unknown[], runId = 1) {
  await board
    .post(`${API}/tasks/${id}/ai-run/${runId}/console/events?sessionId=${SESSION}`, {
      fromRunnerSeq: from,
      events,
    })
    .expect(200);
}

/** A console run 1 whose process runs and is compatible: it takes messages. */
async function readyRun(): Promise<string> {
  const id = await createTask();
  await begin(id);
  await runner(id, 1, [started, compat]);
  return id;
}

const url = (id: string, tail: string, runId = 1) =>
  `${API}/tasks/${id}/ai-run/${runId}/console/${tail}`;

function postMessage(id: string, over: Record<string, unknown> = {}, runId = 1) {
  return board.post(url(id, 'messages', runId), {
    sessionId: SESSION,
    messageId: M1,
    text: 'Hello',
    ...over,
  });
}

async function journal(id: string, runId = 1) {
  const response = await board
    .get(`${API}/tasks/${id}/ai-run/${runId}/console?limit=1000`)
    .expect(200);
  return consoleReadResponse.parse(response.body);
}

const appended = () => board.events.events.filter((event) => event.type === 'console.appended');
const journalFile = (id: string, runId = 1) =>
  join(board.root, '.board', 'console', `${id}-${runId}.ndjson`);

describe('POST .../console/messages', () => {
  it('accepts a message: 201, one entry, exactly one console.appended', async () => {
    const id = await readyRun();
    const before = appended().length;
    const response = await postMessage(id).expect(201);
    expect(response.body).toEqual({ messageId: M1, seq: 3 });

    const { entries, state } = await journal(id);
    expect(entries.at(-1)).toMatchObject({
      seq: 3,
      source: 'server',
      event: { kind: 'user.message', origin: 'board', messageId: M1, text: 'Hello' },
    });
    expect(state.messages).toMatchObject([{ messageId: M1, status: 'accepted' }]);
    expect(appended().length - before).toBe(1);
  });

  it('answers a repeat of the same messageId and text with 200 and writes nothing (INVARIANT)', async () => {
    const id = await readyRun();
    await postMessage(id).expect(201);
    const before = appended().length;
    const again = await postMessage(id).expect(200);
    expect(again.body).toEqual({ messageId: M1, seq: 3 });
    expect((await journal(id)).entries).toHaveLength(3);
    expect(appended().length).toBe(before);
  });

  it('refuses the same messageId with another text: 409 MESSAGE_ID_CONFLICT', async () => {
    const id = await readyRun();
    await postMessage(id).expect(201);
    const response = await postMessage(id, { text: 'Another' }).expect(409);
    expect(code(response.body)).toBe('MESSAGE_ID_CONFLICT');
    expect((await journal(id)).entries).toHaveLength(3);
  });

  it.each([
    ['not a UUID messageId', { messageId: 'nope' }],
    ['not a UUID sessionId', { sessionId: 'nope' }],
    ['empty text', { text: '' }],
    ['blank text', { text: ' \n\t ' }],
    ['text over 4000 characters', { text: 'x'.repeat(4001) }],
    ['NUL in the text', { text: 'a\0b' }],
    ['an unknown field', { extra: 1 }],
  ])('refuses %s with 400 and leaves the journal alone', async (_name, over) => {
    const id = await readyRun();
    const file = await readFile(journalFile(id), 'utf8');
    const response = await postMessage(id, over).expect(400);
    expect(code(response.body)).toBe('INVALID_REQUEST');
    expect(await readFile(journalFile(id), 'utf8')).toBe(file);
  });

  it('takes 4000 characters', async () => {
    const id = await readyRun();
    await postMessage(id, { text: 'x'.repeat(4000) }).expect(201);
  });

  it('refuses while the compatibility is probed: 409 CONSOLE_NOT_READY', async () => {
    const id = await createTask();
    await begin(id);
    await runner(id, 1, [started]);
    const file = await readFile(journalFile(id), 'utf8');
    const response = await postMessage(id).expect(409);
    expect(code(response.body)).toBe('CONSOLE_NOT_READY');
    expect(await readFile(journalFile(id), 'utf8')).toBe(file);
  });

  it('refuses an incompatible session: 409 CONSOLE_UNAVAILABLE', async () => {
    const id = await createTask();
    await begin(id);
    await runner(id, 1, [started, { kind: 'compat.failed', reason: 'no-init' }]);
    const response = await postMessage(id).expect(409);
    expect(code(response.body)).toBe('CONSOLE_UNAVAILABLE');
  });

  it('refuses a closing session and an exited one: 409 CONSOLE_UNAVAILABLE', async () => {
    const id = await readyRun();
    await runner(id, 3, [{ kind: 'close.requested', reason: 'board' }]);
    expect(code((await postMessage(id).expect(409)).body)).toBe('CONSOLE_UNAVAILABLE');
    await runner(id, 4, [exited]);
    expect(code((await postMessage(id).expect(409)).body)).toBe('CONSOLE_UNAVAILABLE');
  });

  it('does not read aiRun.state: after the agent reported finished it still takes messages (INVARIANT)', async () => {
    const id = await readyRun();
    await board
      .patch(`${API}/tasks/${id}/ai-run/1/report`, { agent: 'claude-code', state: 'finished' })
      .expect(200);
    await postMessage(id).expect(201);
  });

  it('refuses after the end of the run: 409 CONSOLE_UNAVAILABLE', async () => {
    const id = await readyRun();
    await board
      .post(`${API}/tasks/${id}/ai-run/1/end`, { sessionId: SESSION, exitCode: 0 })
      .expect(200);
    const file = await readFile(journalFile(id), 'utf8');
    const response = await postMessage(id).expect(409);
    expect(code(response.body)).toBe('CONSOLE_UNAVAILABLE');
    expect(await readFile(journalFile(id), 'utf8')).toBe(file);
  });

  it('refuses a message for the run that a new run replaced: 409 STALE_AI_RUN', async () => {
    const id = await readyRun();
    await board
      .post(`${API}/tasks/${id}/ai-run/1/end`, { sessionId: SESSION, exitCode: 0 })
      .expect(200);
    await begin(id, { mode: 'resume' });
    const file = await readFile(journalFile(id, 1), 'utf8');
    const response = await postMessage(id, {}, 1).expect(409);
    expect(code(response.body)).toBe('STALE_AI_RUN');
    expect(await readFile(journalFile(id, 1), 'utf8')).toBe(file);
  });

  it('refuses another session, another run, a run that is not a console run, and no task', async () => {
    const id = await readyRun();
    const file = await readFile(journalFile(id), 'utf8');
    expect(code((await postMessage(id, { sessionId: OTHER_SESSION }).expect(409)).body)).toBe(
      'STALE_AI_RUN',
    );
    expect(code((await postMessage(id, {}, 2).expect(409)).body)).toBe('STALE_AI_RUN');
    expect(await readFile(journalFile(id), 'utf8')).toBe(file);

    const plain = await createTask();
    await board
      .post(`${API}/tasks/${plain}/ai-run`, { sessionId: SESSION, mode: 'new' })
      .expect(200);
    expect(code((await postMessage(plain).expect(409)).body)).toBe('CONSOLE_UNAVAILABLE');

    expect(code((await postMessage('T999').expect(404)).body)).toBe('TASK_NOT_FOUND');
  });

  it('requires the session token (INVARIANT)', async () => {
    const id = await readyRun();
    for (const path of ['messages', 'close', 'kill']) {
      const body = { sessionId: SESSION, messageId: M1, text: 'Hello' };
      const response = await board.agent().post(url(id, path)).send(body).expect(401);
      expect(code(response.body)).toBe('UNAUTHORIZED');
      await board
        .agent()
        .post(url(id, path))
        .set('Authorization', 'Bearer not-the-token')
        .send(body)
        .expect(401);
    }
    expect((await journal(id)).entries).toHaveLength(2);
  });

  it('keeps the messages of one task apart from another (INVARIANT)', async () => {
    const one = await readyRun();
    const two = await readyRun();
    await postMessage(one).expect(201);
    expect((await journal(two)).state.messages).toEqual([]);
    expect((await journal(one)).state.messages).toHaveLength(1);
  });

  it('numbers concurrent messages without a gap and writes one messageId once (INVARIANT)', async () => {
    const id = await readyRun();
    const ids = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    const send = (messageId: string) => postMessage(id, { messageId, text: `m${messageId}` });
    const answers = await Promise.all([...ids.map(send), ...ids.map(send)]);
    expect(answers.filter((a) => a.status === 201)).toHaveLength(8);
    expect(answers.filter((a) => a.status === 200)).toHaveLength(8);
    const { entries } = await journal(id);
    expect(entries.map((entry) => entry.seq)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(entries.filter((entry) => entry.event.kind === 'user.message')).toHaveLength(8);
  });
});

describe('POST .../console/close', () => {
  it('writes close.requested once and answers 200', async () => {
    const id = await readyRun();
    const before = appended().length;
    await board.post(url(id, 'close'), { sessionId: SESSION }).expect(200);
    const { entries, state } = await journal(id);
    expect(entries.at(-1)?.event).toEqual({ kind: 'close.requested', reason: 'board' });
    expect(entries.at(-1)?.source).toBe('server');
    expect(state.process.status).toBe('closing');
    expect(appended().length - before).toBe(1);

    await board.post(url(id, 'close'), { sessionId: SESSION }).expect(200);
    expect((await journal(id)).entries).toHaveLength(3);
  });

  it('refuses after process.exited: 409 CONSOLE_UNAVAILABLE, nothing written', async () => {
    const id = await readyRun();
    await runner(id, 3, [exited]);
    const file = await readFile(journalFile(id), 'utf8');
    const response = await board.post(url(id, 'close'), { sessionId: SESSION }).expect(409);
    expect(code(response.body)).toBe('CONSOLE_UNAVAILABLE');
    expect(await readFile(journalFile(id), 'utf8')).toBe(file);
  });

  it('refuses another session and a run that is not current: 409 STALE_AI_RUN', async () => {
    const id = await readyRun();
    const wrong = await board.post(url(id, 'close'), { sessionId: OTHER_SESSION }).expect(409);
    expect(code(wrong.body)).toBe('STALE_AI_RUN');
    const old = await board.post(url(id, 'close', 7), { sessionId: SESSION }).expect(409);
    expect(code(old.body)).toBe('STALE_AI_RUN');
  });
});

describe('POST .../console/kill', () => {
  it('is refused while the session is running: 409 CONSOLE_UNAVAILABLE', async () => {
    const id = await readyRun();
    const response = await board.post(url(id, 'kill'), { sessionId: SESSION }).expect(409);
    expect(code(response.body)).toBe('CONSOLE_UNAVAILABLE');
    expect((await journal(id)).entries).toHaveLength(2);
  });

  it('is taken while the session is closing, and writes nothing itself', async () => {
    const id = await readyRun();
    await board.post(url(id, 'close'), { sessionId: SESSION }).expect(200);
    await board.post(url(id, 'kill'), { sessionId: SESSION }).expect(200);
    expect((await journal(id)).entries).toHaveLength(3);
  });

  it('is refused once the process exited', async () => {
    const id = await readyRun();
    await board.post(url(id, 'close'), { sessionId: SESSION }).expect(200);
    await runner(id, 3, [exited]);
    const response = await board.post(url(id, 'kill'), { sessionId: SESSION }).expect(409);
    expect(code(response.body)).toBe('CONSOLE_UNAVAILABLE');
  });
});

describe('the instructions of agents (INVARIANT)', () => {
  it('do not mention the messages, close, kill and inbox routes', () => {
    const instructions = generateInstructions({
      baseUrl: 'http://127.0.0.1:7432/api/v1',
      board: { name: 'board', statuses: ['backlog', 'done'], idPrefix: 'T' },
    });
    for (const tail of ['messages', 'close', 'kill', 'inbox']) {
      expect(instructions).not.toContain(`/console/${tail}`);
    }
  });
});
