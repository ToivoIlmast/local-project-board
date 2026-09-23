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

async function create(title: string, status = 'todo'): Promise<string> {
  const response = await board.post(`${API}/tasks`, { title, status }).expect(201);
  return taskSchema.parse(response.body).id;
}

/** Titles in board order within one column, as the API reports them. */
async function column(status: string): Promise<string[]> {
  const response = await board.get(`${API}/tasks`).expect(200);
  return z
    .array(taskSchema)
    .parse(response.body)
    .filter((task) => task.status === status)
    .map((task) => task.title);
}

async function move(id: string, body: Record<string, unknown>): Promise<number> {
  const response = await board.post(`${API}/tasks/${id}/move`, body);
  return response.status;
}

describe('POST /tasks/:id/move', () => {
  it('moves a task to another column', async () => {
    const id = await create('a');
    const response = await board.post(`${API}/tasks/${id}/move`, { status: 'done' }).expect(200);

    expect(taskSchema.parse(response.body).status).toBe('done');
    expect(await column('done')).toEqual(['a']);
    expect(await column('todo')).toEqual([]);
    expect(board.events.types().at(-1)).toBe('task.updated');
  });

  it('reorders within the same column: to the beginning, between and to the end', async () => {
    const a = await create('a');
    await create('b');
    const c = await create('c');
    expect(await column('todo')).toEqual(['a', 'b', 'c']);

    expect(await move(c, { status: 'todo', before: a })).toBe(200);
    expect(await column('todo')).toEqual(['c', 'a', 'b']);

    expect(await move(c, { status: 'todo', after: a })).toBe(200);
    expect(await column('todo')).toEqual(['a', 'c', 'b']);

    expect(await move(a, { status: 'todo' })).toBe(200);
    expect(await column('todo')).toEqual(['c', 'b', 'a']);
  });

  it('places the card after `after` when both neighbours are given', async () => {
    const a = await create('a');
    await create('b');
    const c = await create('c');
    const x = await create('x');

    expect(await move(x, { status: 'todo', after: a, before: c })).toBe(200);
    expect(await column('todo')).toEqual(['a', 'x', 'b', 'c']);
  });

  it('computes the rank on the server: the request never carries one', async () => {
    const first = await create('first', 'done');
    const id = await create('a');
    const firstRank = taskSchema.parse((await board.get(`${API}/tasks/${first}`)).body).rank;

    await board.post(`${API}/tasks/${id}/move`, { status: 'done', rank: firstRank }).expect(400);

    const moved = await board.post(`${API}/tasks/${id}/move`, { status: 'done' }).expect(200);
    // The card lands after the one already there; the rank the client offered is ignored.
    expect(taskSchema.parse(moved.body).rank > firstRank).toBe(true);
    expect(await column('done')).toEqual(['first', 'a']);
  });

  it('refuses a neighbour that is not in the target column', async () => {
    const a = await create('a');
    const elsewhere = await create('b', 'backlog');

    const response = await board.post(`${API}/tasks/${a}/move`, {
      status: 'todo',
      after: elsewhere,
    });
    expect(response.status).toBe(422);
    const { error } = errorResponseSchema.parse(response.body);
    expect(error.code).toBe('NEIGHBOR_NOT_FOUND');
    expect(error.details).toMatchObject({ id: elsewhere });
  });

  it('refuses an impossible position', async () => {
    const a = await create('a');
    const b = await create('b');
    const x = await create('x');

    const inverted = await board.post(`${API}/tasks/${x}/move`, {
      status: 'todo',
      after: b,
      before: a,
    });
    expect(inverted.status).toBe(422);
    expect(errorResponseSchema.parse(inverted.body).error.code).toBe('INVALID_POSITION');

    const itself = await board.post(`${API}/tasks/${x}/move`, { status: 'todo', after: x });
    expect(itself.status).toBe(422);
    expect(errorResponseSchema.parse(itself.body).error.code).toBe('INVALID_POSITION');
  });

  it('refuses a malformed neighbour id, a missing status and an unknown status', async () => {
    const id = await create('a');
    expect(await move(id, { status: 'todo', after: 'not-an-id' })).toBe(400);
    expect(await move(id, {})).toBe(400);
    expect(await move(id, { status: 'nope' })).toBe(422);
    expect(await column('todo')).toEqual(['a']);
  });

  it('answers 404 for a task that does not exist', async () => {
    expect(await move('T99', { status: 'todo' })).toBe(404);
  });
});
