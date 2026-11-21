import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  API_BASE_PATH as API,
  errorResponseSchema,
  taskSchema,
} from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { openStream, type SseClient } from '../support/sse.js';
import { cleanTmpDirs } from '../support/tmp.js';

/** Archiving a task and restoring it (T3): routes, refusals, events, and what stays as it was. */

let board: TestBoard;
const open: SseClient[] = [];
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

async function create(status: string): Promise<string> {
  const response = await board.post(`${API}/tasks`, { title: `In ${status}`, status }).expect(201);
  return (response.body as { id: string }).id;
}

/** A task as it is read, without the time of the last write, the mark and the readiness, which only a read has. */
function sameness(task: unknown): Record<string, unknown> {
  const { updatedAt: _u, archived: _a, readiness: _r, ...rest } = task as Record<string, unknown>;
  return rest;
}

describe('POST /tasks/:id/archive and /restore', () => {
  it.each(['backlog', 'todo', 'in-progress', 'done'])(
    'archives and restores a task of %s and leaves everything else as it was (INVARIANT)',
    async (status) => {
      const id = await create(status);
      await board.put(`${API}/tasks/${id}/documents/plan.md`, { content: '# Plan\n' }).expect(200);
      const before = (await board.get(`${API}/tasks/${id}`).expect(200)).body as object;
      const versions = (await board.get(`${API}/tasks/${id}/versions`).expect(200)).body as object;

      const archived = (await board.post(`${API}/tasks/${id}/archive`).expect(200)).body;
      expect(taskSchema.parse(archived).archived?.at).toMatch(/^\d{4}-/);
      expect(sameness(archived)).toEqual(sameness(before));

      // Still read, still listed, in the same place, with the mark.
      const list = (await board.get(`${API}/tasks`).expect(200)).body as { id: string }[];
      expect(list.map((task) => task.id)).toContain(id);
      expect((await board.get(`${API}/tasks/${id}`).expect(200)).body).toHaveProperty('archived');

      const restored = (await board.post(`${API}/tasks/${id}/restore`).expect(200)).body;
      expect(restored).not.toHaveProperty('archived');
      expect(sameness(restored)).toEqual(sameness(before));
      expect((await board.get(`${API}/tasks/${id}/versions`).expect(200)).body).toEqual(versions);
      expect((await board.get(`${API}/tasks/${id}/documents`).expect(200)).body).toHaveLength(1);
    },
  );

  it('keeps the file, the directory and the id of an archived task', async () => {
    const id = await create('todo');
    await board.post(`${API}/tasks/${id}/archive`).expect(200);
    expect(await readdir(join(board.root, '.board', 'tasks', id))).toContain('task.md');
    const next = (await board.post(`${API}/tasks`, { title: 'Next' }).expect(201)).body as {
      id: string;
    };
    expect(next.id).not.toBe(id);
  });

  it('needs the session token', async () => {
    const id = await create('todo');
    for (const action of ['archive', 'restore']) {
      const response = await board.agent().post(`${API}/tasks/${id}/${action}`).send({});
      expect(response.status).toBe(401);
      expect(code(response.body)).toBe('UNAUTHORIZED');
    }
    expect((await board.get(`${API}/tasks/${id}`)).body).not.toHaveProperty('archived');
  });

  it('answers 404 for a task that does not exist', async () => {
    for (const action of ['archive', 'restore']) {
      const response = await board.post(`${API}/tasks/T404/${action}`).expect(404);
      expect(code(response.body)).toBe('TASK_NOT_FOUND');
    }
  });

  it('refuses to restore a task that is not archived, and to archive one twice (409)', async () => {
    const id = await create('todo');
    const restore = await board.post(`${API}/tasks/${id}/restore`).expect(409);
    expect(code(restore.body)).toBe('TASK_NOT_ARCHIVED');

    await board.post(`${API}/tasks/${id}/archive`).expect(200);
    const again = await board.post(`${API}/tasks/${id}/archive`).expect(409);
    expect(code(again.body)).toBe('TASK_ARCHIVED');
  });

  it('refuses a move and another status of an archived task, so that restore returns it', async () => {
    const id = await create('todo');
    await board.post(`${API}/tasks/${id}/archive`).expect(200);

    const move = await board.post(`${API}/tasks/${id}/move`, { status: 'done' }).expect(409);
    expect(code(move.body)).toBe('TASK_ARCHIVED');
    const patch = await board.patch(`${API}/tasks/${id}`, { status: 'done' }).expect(409);
    expect(code(patch.body)).toBe('TASK_ARCHIVED');

    // The content, the same status, the documents and the delete are as for any task.
    await board.patch(`${API}/tasks/${id}`, { title: 'Renamed', status: 'todo' }).expect(200);
    await board.put(`${API}/tasks/${id}/documents/n.md`, { content: 'n' }).expect(200);
    expect(((await board.get(`${API}/tasks/${id}`)).body as { status: string }).status).toBe(
      'todo',
    );
    await board.del(`${API}/tasks/${id}`).expect(200);
  });

  it('refuses the handoff and every kind of run of an archived task', async () => {
    const id = await create('todo');
    await board.post(`${API}/tasks/${id}/archive`).expect(200);

    const handoff = await board.get(`${API}/tasks/${id}/handoff`).expect(409);
    expect(code(handoff.body)).toBe('TASK_ARCHIVED');
    for (const body of [
      { agent: 'claude-code' },
      { agent: 'claude-code', kind: 'check' },
      { agent: 'claude-code', kind: 'research' },
    ]) {
      const run = await board.post(`${API}/tasks/${id}/run`, body).expect(409);
      expect(code(run.body)).toBe('TASK_ARCHIVED');
    }

    await board.post(`${API}/tasks/${id}/restore`).expect(200);
    await board.get(`${API}/tasks/${id}/handoff`).expect(200);
  });

  it('refuses to archive a task whose run works, and allows it when the run is over', async () => {
    const id = await create('todo');
    await board.post(`${API}/tasks/${id}/ai-run`, { sessionId: SESSION, mode: 'new' }).expect(200);

    const refused = await board.post(`${API}/tasks/${id}/archive`).expect(409);
    expect(code(refused.body)).toBe('AI_RUN_IN_PROGRESS');

    await board.post(`${API}/tasks/${id}/ai-run/1/end`, { exitCode: 0 }).expect(200);
    const archived = (await board.post(`${API}/tasks/${id}/archive`).expect(200)).body as {
      aiRun: { runId: number };
    };
    expect(archived.aiRun.runId).toBe(1);
  });

  it('refuses to archive a task with a check that has not ended', async () => {
    const id = await create('todo');
    await board
      .post(`${API}/tasks/${id}/checks`, { agent: 'claude-code', sessionId: SESSION })
      .expect(200);

    const refused = await board.post(`${API}/tasks/${id}/archive`).expect(409);
    expect(code(refused.body)).toBe('CHECK_IN_PROGRESS');
  });

  it('publishes task.updated for each, and no version', async () => {
    const id = await create('todo');
    const client = await openStream(board.port, `${API}/events`);
    open.push(client);

    const archived = (await board.post(`${API}/tasks/${id}/archive`).expect(200)).body;
    const restored = (await board.post(`${API}/tasks/${id}/restore`).expect(200)).body;

    expect(await client.waitForEvents(2)).toEqual([
      { type: 'task.updated', task: archived },
      { type: 'task.updated', task: restored },
    ]);
  });

  it('leaves the readiness of what depends on an archived task as it was', async () => {
    const dependency = await create('todo');
    const dependant = (
      await board
        .post(`${API}/tasks`, { title: 'Waits', status: 'todo', dependsOn: [dependency] })
        .expect(201)
    ).body as { id: string };
    const reasons = async (): Promise<unknown> =>
      ((await board.get(`${API}/tasks/${dependant.id}`)).body as { readiness: unknown }).readiness;
    const blocked = { reasons: [{ code: 'task-not-done', task: dependency }] };

    expect(await reasons()).toEqual(blocked);
    await board.post(`${API}/tasks/${dependency}/archive`).expect(200);
    expect(await reasons()).toEqual(blocked);
  });
});
