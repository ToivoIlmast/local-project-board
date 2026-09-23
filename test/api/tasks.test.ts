import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  API_BASE_PATH as API,
  errorResponseSchema,
  taskSchema,
} from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { cleanTmpDirs } from '../support/tmp.js';

let board: TestBoard;

beforeEach(async () => {
  board = await createTestBoard();
});

afterEach(async () => {
  await board.close();
  await cleanTmpDirs();
});

const draft = { title: 'Extract the git adapter', body: '## Context\n\nStill in HTTP.\n' };

async function createTask(body: Record<string, unknown> = draft): Promise<string> {
  const response = await board.post(`${API}/tasks`, body).expect(201);
  return z.string().parse((response.body as { id: string }).id);
}

describe('GET /tasks', () => {
  it('answers with an empty list on a new board', async () => {
    const response = await board.get(`${API}/tasks`).expect(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(z.array(taskSchema).parse(response.body)).toEqual([]);
  });

  it('orders tasks by status and then by rank', async () => {
    await createTask({ title: 'done one', status: 'done' });
    await createTask({ title: 'first todo', status: 'todo' });
    await createTask({ title: 'second todo', status: 'todo' });

    const response = await board.get(`${API}/tasks`).expect(200);
    expect(
      z
        .array(taskSchema)
        .parse(response.body)
        .map((task) => task.title),
    ).toEqual(['first todo', 'second todo', 'done one']);
  });
});

describe('POST /tasks', () => {
  it('creates a task, answers with it and writes it to disk', async () => {
    const response = await board.post(`${API}/tasks`, draft).expect(201);
    const task = taskSchema.parse(response.body);

    expect(task).toMatchObject({ id: 'T1', title: draft.title, status: 'backlog', labels: [] });
    expect(await board.storage.getTask('T1')).toMatchObject({ title: draft.title });
    const file = await readFile(join(board.root, '.board', 'tasks', 'T1', 'task.md'), 'utf8');
    expect(file).toContain('title: Extract the git adapter');
    expect(board.events.types()).toEqual(['task.created']);
  });

  it('rejects a request the contract does not describe', async () => {
    const blank = await board.post(`${API}/tasks`, { title: '  ' }).expect(400);
    expect(errorResponseSchema.parse(blank.body).error.code).toBe('INVALID_REQUEST');

    const missing = await board.post(`${API}/tasks`, {}).expect(400);
    expect(JSON.stringify(missing.body)).toContain('title');

    const unknownField = await board.post(`${API}/tasks`, { title: 'x', rank: 'a0' }).expect(400);
    expect(errorResponseSchema.parse(unknownField.body).error.code).toBe('INVALID_REQUEST');

    expect(await board.storage.listTasks()).toEqual([]);
    expect(board.events.types()).toEqual([]);
  });

  it('refuses a status the board does not have', async () => {
    const response = await board.post(`${API}/tasks`, { title: 'x', status: 'nope' }).expect(422);
    const { error } = errorResponseSchema.parse(response.body);
    expect(error.code).toBe('UNKNOWN_STATUS');
    expect(error.details).toMatchObject({ status: 'nope' });
  });
});

describe('GET /tasks/:id', () => {
  it('reads one task with its markdown body', async () => {
    const id = await createTask();
    const response = await board.get(`${API}/tasks/${id}`).expect(200);
    expect(taskSchema.parse(response.body).body).toBe(draft.body);
  });

  it('answers 404 for a task that does not exist', async () => {
    const response = await board.get(`${API}/tasks/T99`).expect(404);
    expect(errorResponseSchema.parse(response.body).error.code).toBe('TASK_NOT_FOUND');
  });

  it('answers 400 for something that is not a task id', async () => {
    const response = await board.get(`${API}/tasks/not-an-id`).expect(400);
    expect(errorResponseSchema.parse(response.body).error.code).toBe('INVALID_REQUEST');
  });
});

describe('PATCH /tasks/:id', () => {
  it('changes only the given fields and persists them', async () => {
    const id = await createTask();
    const response = await board.patch(`${API}/tasks/${id}`, { title: 'Renamed' }).expect(200);

    const task = taskSchema.parse(response.body);
    expect(task).toMatchObject({ id, title: 'Renamed', body: draft.body });
    expect(await board.storage.getTask(id)).toMatchObject({ title: 'Renamed' });
    expect(board.events.types()).toEqual(['task.created', 'task.updated']);
  });

  it('refuses an empty patch, an unknown field and an unknown status', async () => {
    const id = await createTask();
    await board.patch(`${API}/tasks/${id}`, {}).expect(400);
    await board.patch(`${API}/tasks/${id}`, { id: 'T9' }).expect(400);
    await board.patch(`${API}/tasks/${id}`, { status: 'nope' }).expect(422);
    expect(await board.storage.getTask(id)).toMatchObject({ title: draft.title });
  });

  it('answers 404 for a task that does not exist', async () => {
    await board.patch(`${API}/tasks/T99`, { title: 'x' }).expect(404);
  });
});

describe('DELETE /tasks/:id', () => {
  it('deletes the task and then answers 404 for it', async () => {
    const id = await createTask();
    const response = await board.del(`${API}/tasks/${id}`).expect(200);

    expect(response.body).toEqual({ deleted: true });
    await board.get(`${API}/tasks/${id}`).expect(404);
    expect(await board.storage.listTasks()).toEqual([]);
    expect(board.events.types()).toEqual(['task.created', 'task.deleted']);
  });

  it('answers 404 for a task that does not exist', async () => {
    const response = await board.del(`${API}/tasks/T99`).expect(404);
    expect(errorResponseSchema.parse(response.body).error.code).toBe('TASK_NOT_FOUND');
  });
});
