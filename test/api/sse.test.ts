import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { API_BASE_PATH as API, errorResponseSchema, routes } from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { openStream, type SseClient } from '../support/sse.js';
import { cleanTmpDirs } from '../support/tmp.js';

let board: TestBoard;
const open: SseClient[] = [];

const EVENTS = `${API}${routes['events.stream'].path}`;

async function stream(headers: Record<string, string> = {}): Promise<SseClient> {
  const client = await openStream(board.port, EVENTS, headers);
  open.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  await board.close();
  await cleanTmpDirs();
});

describe('GET /events', () => {
  beforeEach(async () => {
    board = await createTestBoard();
  });

  it('answers as a stream that is never cached and never ends', async () => {
    const client = await stream();

    expect(client.status).toBe(200);
    expect(client.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(client.headers['cache-control']).toBe('no-store');
    expect(client.headers['content-length']).toBeUndefined();
    expect(board.bus.size).toBe(1);
  });

  it('delivers what a mutation over HTTP published, as the contract describes it', async () => {
    const client = await stream();

    const created = await board.post(`${API}/tasks`, { title: 'Watch me' }).expect(201);
    const [event] = await client.waitForEvents(1);

    expect(event).toEqual({ type: 'task.created', task: created.body });
  });

  it('follows a whole session: update, move, documents, reports, delete', async () => {
    const client = await stream();
    const id = 'T1';

    await board.post(`${API}/tasks`, { title: 'a' }).expect(201);
    await board.patch(`${API}/tasks/${id}`, { title: 'b' }).expect(200);
    await board.post(`${API}/tasks/${id}/move`, { status: 'done' }).expect(200);
    await board.put(`${API}/tasks/${id}/documents/plan.md`, { content: '# Plan\n' }).expect(200);
    await board.del(`${API}/tasks/${id}/documents/plan.md`).expect(200);
    await board.post(`${API}/reports`, { title: 'r', format: 'md', content: '# r\n' }).expect(201);
    await board.del(`${API}/reports/R1`).expect(200);
    await board.del(`${API}/tasks/${id}`).expect(200);

    const events = await client.waitForEvents(8);
    expect(events.map((event) => event.type)).toEqual([
      'task.created',
      'task.updated',
      'task.updated',
      'document.written',
      'document.deleted',
      'report.created',
      'report.deleted',
      'task.deleted',
    ]);
  });

  it('gives every open client the same events', async () => {
    const first = await stream();
    const second = await stream();

    await board.post(`${API}/tasks`, { title: 'a' }).expect(201);

    expect(await first.waitForEvents(1)).toEqual(await second.waitForEvents(1));
    expect(board.bus.size).toBe(2);
  });

  it('sends nothing that happened before the client arrived', async () => {
    await board.post(`${API}/tasks`, { title: 'before' }).expect(201);
    const client = await stream();
    await board.post(`${API}/tasks`, { title: 'after' }).expect(201);

    const events = await client.waitForEvents(1);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).toContain('after');
  });

  it('forgets a client that goes away, and keeps answering the others', async () => {
    const leaving = await stream();
    const staying = await stream();
    expect(board.bus.size).toBe(2);

    await leaving.close();
    await board.post(`${API}/tasks`, { title: 'a' }).expect(201);

    await staying.waitForEvents(1);
    expect(board.bus.size).toBe(1);
    expect(leaving.events).toEqual([]);
  });

  it('tells the browser how long to wait before reconnecting', async () => {
    const client = await stream();
    await client.waitFor((c) => c.raw().includes('retry:'), 'the retry hint');
    expect(client.raw()).toMatch(/^retry: \d+$/m);
  });
});

describe('workflow settings', () => {
  const overrides = { board: { push: true }, statuses: { backlog: { editCode: false } } };

  beforeEach(async () => {
    board = await createTestBoard();
  });

  it('are announced after a PUT, with the state that was answered', async () => {
    const client = await stream();

    const response = await board.put(`${API}/workflow`, overrides).expect(200);

    const [event] = await client.waitForEvents(1);
    expect(event).toEqual({ type: 'workflow.updated', workflow: response.body });
  });

  it('are not announced when the PUT was refused', async () => {
    const client = await stream();

    await board.put(`${API}/workflow`, { board: {}, statuses: { nope: {} } }).expect(422);
    await board.put(`${API}/workflow`, { board: { deploy: true }, statuses: {} }).expect(400);
    await board.agent().put(`${API}/workflow`).send(overrides).expect(401);
    // The next event proves the refused ones did not slip in before it.
    await board.post(`${API}/tasks`, { title: 'after' }).expect(201);

    const events = await client.waitForEvents(1);
    expect(events.map((event) => event.type)).toEqual(['task.created']);
  });

  it("a task's own overrides arrive as task.updated, with the task", async () => {
    await board.post(`${API}/tasks`, { title: 'a' }).expect(201);
    const client = await stream();

    const response = await board.patch(`${API}/tasks/T1`, { workflow: { push: true } }).expect(200);

    const [event] = await client.waitForEvents(1);
    expect(event).toEqual({ type: 'task.updated', task: response.body });
    expect(event).toMatchObject({ task: { workflow: { push: true } } });
  });

  it('are not announced by a read of the settings', async () => {
    await board.post(`${API}/tasks`, { title: 'a' }).expect(201);
    const client = await stream();

    await board.get(`${API}/workflow`).expect(200);
    await board.get(`${API}/tasks/T1/workflow`).expect(200);
    await board.post(`${API}/tasks`, { title: 'b' }).expect(201);

    expect((await client.waitForEvents(1)).map((event) => event.type)).toEqual(['task.created']);
  });
});

describe('a change made to .board/workflow.yaml outside the server', () => {
  it('reaches the open clients as board.changed, and the next read shows it', async () => {
    board = await createTestBoard({ watch: true });
    const client = await stream();

    await writeFile(
      join(board.root, '.board', 'workflow.yaml'),
      'formatVersion: 1\nboard:\n  push: true\n',
    );

    await client.waitFor((c) => c.events.some((e) => e.type === 'board.changed'), 'board.changed');
    const state = await board.get(`${API}/workflow`).expect(200);
    expect(state.body).toMatchObject({ board: { push: true }, statuses: {} });
  }, 20_000);
});

describe('a stream that is left open', () => {
  it('is kept alive by a heartbeat that is not an event', async () => {
    board = await createTestBoard({ sseHeartbeatMs: 30 });
    const client = await stream();

    await client.waitFor((c) => c.raw().split(':ping').length > 2, 'two heartbeats');
    expect(client.events).toEqual([]);
  });

  it('does not keep the server from stopping', async () => {
    board = await createTestBoard();
    await stream();

    // close() is the shutdown the CLI performs; without it this test would time out.
    await expect(board.close()).resolves.toBeUndefined();
    board = await createTestBoard();
  });
});

describe('a change made outside the server', () => {
  it('reaches the open clients as board.changed', async () => {
    board = await createTestBoard({ watch: true });
    const client = await stream();

    await writeFile(join(board.root, '.board', 'tasks', 'note.txt'), 'an agent was here\n');

    const events = await client.waitForEvents(1);
    expect(events[0]).toEqual({ type: 'board.changed' });
  }, 20_000);
});

describe('the watcher next to the events of the server', () => {
  it("may echo the server's own write first, and the event of the write still arrives", async () => {
    board = await createTestBoard({ watch: true });
    const created = await board.post(`${API}/tasks`, { title: 'a' }).expect(201);
    const client = await stream();

    // Longer than the watcher waits to report the write above (ADR-0019: the echo of an own
    // write is harmless): it reaches this client before the change made next.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const renamed = await board.patch(`${API}/tasks/T1`, { title: 'b' }).expect(200);

    await client.waitFor((c) => c.events.some((e) => e.type === 'task.updated'), 'task.updated');
    expect(client.events).toContainEqual({ type: 'task.updated', task: renamed.body });
    expect(created.body).toMatchObject({ id: 'T1' });
  }, 20_000);
});

describe('the stream and the security boundary', () => {
  beforeEach(async () => {
    board = await createTestBoard();
  });

  it('is open to a client with no Origin and no token, as reads are', async () => {
    const client = await stream();
    expect(client.status).toBe(200);
  });

  it('is refused to a page of another origin', async () => {
    const response = await board.agent().get(EVENTS).set('Origin', 'http://evil.com');
    expect(response.status).toBe(403);
    expect(errorResponseSchema.parse(response.body).error.code).toBe('FORBIDDEN_ORIGIN');
    expect(board.bus.size).toBe(0);
  });

  it('is refused to a request addressed to another host', async () => {
    const response = await board.agent().get(EVENTS).set('Host', `evil.com:${board.port}`);
    expect(response.status).toBe(403);
    expect(board.bus.size).toBe(0);
  });

  it('takes no method but GET', async () => {
    await board.post(EVENTS, {}).expect(405);
  });
});
