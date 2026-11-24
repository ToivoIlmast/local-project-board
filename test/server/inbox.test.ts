import {
  API_BASE_PATH as API,
  consoleReadResponse,
  inboxFrameSchema,
  type InboxFrame,
} from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { openStream, type SseClient } from '../support/sse.js';
import { cleanTmpDirs } from '../support/tmp.js';

/**
 * The runner's inbox (plan C10, §9.3): what the page hands the board arrives as frames, in the
 * order of the journal, and the stream is the runner's alone.
 */

let board: TestBoard;
const clients: SseClient<InboxFrame>[] = [];

beforeEach(async () => {
  board = await createTestBoard();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await board.close();
  await cleanTmpDirs();
});

const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';
const OTHER_SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456790';
const mid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const started = { kind: 'process.started', pid: 4242 };
const compat = { kind: 'compat.passed' };
const exited = { kind: 'process.exited', exitCode: 0, signal: null, lastTurnOpen: false };

async function createTask(): Promise<string> {
  const response = await board.post(`${API}/tasks`, { title: 'Ship it' }).expect(201);
  return (response.body as { id: string }).id;
}

async function readyRun(): Promise<string> {
  const id = await createTask();
  await board
    .post(`${API}/tasks/${id}/ai-run`, { sessionId: SESSION, mode: 'new', console: true })
    .expect(200);
  await runner(id, 1, [started, compat]);
  return id;
}

async function runner(id: string, from: number, events: unknown[]) {
  await board
    .post(`${API}/tasks/${id}/ai-run/1/console/events?sessionId=${SESSION}`, {
      fromRunnerSeq: from,
      events,
    })
    .expect(200);
}

const send = (id: string, n: number, text = `text ${n}`) =>
  board.post(`${API}/tasks/${id}/ai-run/1/console/messages`, {
    sessionId: SESSION,
    messageId: mid(n),
    text,
  });

const inboxPath = (id: string, sessionId = SESSION, runId = 1) =>
  `${API}/tasks/${id}/ai-run/${runId}/console/inbox?sessionId=${sessionId}`;

async function connect(id: string, over: { sessionId?: string; runId?: number } = {}) {
  const client = await openStream<InboxFrame>(
    board.port,
    inboxPath(id, over.sessionId, over.runId),
    { Authorization: `Bearer ${board.token}` },
    (data) => inboxFrameSchema.parse(data),
  );
  clients.push(client);
  return client;
}

async function status(id: string, path: string, headers: Record<string, string> = {}) {
  const client = await openStream<InboxFrame>(board.port, path, headers, (d) =>
    inboxFrameSchema.parse(d),
  );
  clients.push(client);
  return client.status;
}

const frames = (client: SseClient<InboxFrame>) => client.events;

describe('GET .../console/inbox', () => {
  it('needs the session token (INVARIANT)', async () => {
    const id = await readyRun();
    expect(await status(id, inboxPath(id))).toBe(401);
    expect(await status(id, inboxPath(id), { Authorization: 'Bearer not-the-token' })).toBe(401);
  });

  it('is refused for another session, another run and a run that is not a console run', async () => {
    const id = await readyRun();
    const token = { Authorization: `Bearer ${board.token}` };
    expect(await status(id, inboxPath(id, OTHER_SESSION), token)).toBe(409);
    expect(await status(id, inboxPath(id, SESSION, 5), token)).toBe(409);
  });

  it('sends the messages that are accepted, in the order of seq, and then the new ones', async () => {
    const id = await readyRun();
    await send(id, 1).expect(201);
    await send(id, 2).expect(201);
    const client = await connect(id);
    await client.waitForEvents(2);
    expect(frames(client)).toEqual([
      { type: 'message', messageId: mid(1), text: 'text 1' },
      { type: 'message', messageId: mid(2), text: 'text 2' },
    ]);

    await send(id, 3).expect(201);
    await client.waitForEvents(3);
    expect(frames(client)[2]).toEqual({ type: 'message', messageId: mid(3), text: 'text 3' });
  });

  it('does not send a message that is queued already (INVARIANT)', async () => {
    const id = await readyRun();
    await send(id, 1).expect(201);
    await send(id, 2).expect(201);
    await runner(id, 3, [{ kind: 'user.lifecycle', messageId: mid(1), state: 'queued' }]);
    const client = await connect(id);
    await client.waitForEvents(1);
    expect(frames(client)).toEqual([{ type: 'message', messageId: mid(2), text: 'text 2' }]);
  });

  it('is replaced by a second connection of the same run', async () => {
    const id = await readyRun();
    const first = await connect(id);
    const second = await connect(id);
    await first.waitFor((client) => client.ended(), 'the first inbox to be closed');
    await send(id, 1).expect(201);
    await second.waitForEvents(1);
    expect(frames(second)).toEqual([{ type: 'message', messageId: mid(1), text: 'text 1' }]);
    expect(frames(first)).toEqual([]);
  });

  it('delivers a message after the agent reported: agent-final does not close it (INVARIANT)', async () => {
    const id = await readyRun();
    const client = await connect(id);
    await board
      .patch(`${API}/tasks/${id}/ai-run/1/report`, { agent: 'claude-code', state: 'finished' })
      .expect(200);
    await client.waitForEvents(1);
    expect(frames(client)).toEqual([{ type: 'agent-final', state: 'finished' }]);

    await send(id, 1).expect(201);
    await client.waitForEvents(2);
    expect(frames(client)[1]).toEqual({ type: 'message', messageId: mid(1), text: 'text 1' });
    expect(client.ended()).toBe(false);
  });

  it('does not hand the messages of one run to the inbox of another (INVARIANT)', async () => {
    const one = await readyRun();
    const two = await readyRun();
    const inboxOne = await connect(one);
    const inboxTwo = await connect(two);
    await send(one, 1).expect(201);
    await inboxOne.waitForEvents(1);
    await send(two, 2).expect(201);
    await inboxTwo.waitForEvents(1);
    expect(frames(inboxOne).map((frame) => frame.type === 'message' && frame.messageId)).toEqual([
      mid(1),
    ]);
    expect(frames(inboxTwo).map((frame) => frame.type === 'message' && frame.messageId)).toEqual([
      mid(2),
    ]);
  });

  it('sends close, and kill only while closing', async () => {
    const id = await readyRun();
    const client = await connect(id);
    await board
      .post(`${API}/tasks/${id}/ai-run/1/console/kill`, { sessionId: SESSION })
      .expect(409);
    await board
      .post(`${API}/tasks/${id}/ai-run/1/console/close`, { sessionId: SESSION })
      .expect(200);
    await client.waitForEvents(1);
    expect(frames(client)).toEqual([{ type: 'close' }]);

    await board
      .post(`${API}/tasks/${id}/ai-run/1/console/kill`, { sessionId: SESSION })
      .expect(200);
    await client.waitForEvents(2);
    expect(frames(client)).toEqual([{ type: 'close' }, { type: 'kill' }]);
  });

  it('sends no kill frame while the session runs', async () => {
    const id = await readyRun();
    const client = await connect(id);
    await board
      .post(`${API}/tasks/${id}/ai-run/1/console/kill`, { sessionId: SESSION })
      .expect(409);
    // A later frame proves that the first would have arrived before it.
    await send(id, 1).expect(201);
    await client.waitForEvents(1);
    expect(frames(client)).toEqual([{ type: 'message', messageId: mid(1), text: 'text 1' }]);
  });

  it('is closed by process.exited', async () => {
    const id = await readyRun();
    const client = await connect(id);
    await runner(id, 3, [exited]);
    await client.waitFor((c) => c.ended(), 'the inbox to be closed');
  });

  it('is closed by the end of the run', async () => {
    const id = await readyRun();
    const client = await connect(id);
    await board
      .post(`${API}/tasks/${id}/ai-run/1/end`, { sessionId: SESSION, exitCode: 0 })
      .expect(200);
    await client.waitFor((c) => c.ended(), 'the inbox to be closed');
  });

  it('is closed when a new run replaces the run', async () => {
    const id = await readyRun();
    const client = await connect(id);
    await board
      .post(`${API}/tasks/${id}/ai-run/1/end`, { sessionId: SESSION, exitCode: 0 })
      .expect(200);
    await client.waitFor((c) => c.ended(), 'the inbox to be closed');
    await board
      .post(`${API}/tasks/${id}/ai-run`, { sessionId: SESSION, mode: 'resume', console: true })
      .expect(200);
    const journal = await board.get(`${API}/tasks/${id}/ai-run/1/console`).expect(200);
    expect(consoleReadResponse.parse(journal.body).state.messages).toEqual([]);
  });
});
