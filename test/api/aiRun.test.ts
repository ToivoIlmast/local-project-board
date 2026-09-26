import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  API_BASE_PATH as API,
  errorResponseSchema,
  taskSchema,
} from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { cleanTmpDirs } from '../support/tmp.js';

/**
 * How an agent gives the result of its work back to the board (T27, the model of T20): the
 * `aiRun` of the task, written with the PATCH every agent already uses. The branch stays
 * `task.branch` and the report stays the document `report.md`; this holds the rest.
 */

let board: TestBoard;

beforeEach(async () => {
  board = await createTestBoard();
});

afterEach(async () => {
  await board.close();
  await cleanTmpDirs();
});

const code = (body: unknown): string => errorResponseSchema.parse(body).error.code;

async function createTask(): Promise<string> {
  const response = await board.post(`${API}/tasks`, { title: 'Ship it' }).expect(201);
  return (response.body as { id: string }).id;
}

const finished = {
  agent: 'claude-code',
  state: 'finished',
  checks: 'passed',
  commit: '9f1c1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b',
  startedAt: '2026-09-26T10:00:00.000Z',
  finishedAt: '2026-09-26T11:00:00.000Z',
};

describe('aiRun: the result of an agent, on its task (T27)', () => {
  it('takes every field of the model and answers with the task that carries it', async () => {
    const id = await createTask();

    const response = await board.patch(`${API}/tasks/${id}`, { aiRun: finished }).expect(200);

    expect(taskSchema.parse(response.body).aiRun).toEqual(finished);
    expect((await board.get(`${API}/tasks/${id}`).expect(200)).body.aiRun).toEqual(finished);
  });

  it('is written into the file of the task, next to the branch, for the developer to read', async () => {
    const id = await createTask();
    await board
      .patch(`${API}/tasks/${id}`, { aiRun: finished, branch: 'task/T1-ship-it' })
      .expect(200);

    const file = await readFile(join(board.root, '.board', 'tasks', id, 'task.md'), 'utf8');
    expect(file).toMatch(/^aiRun:\n {2}agent: claude-code\n {2}state: finished\n/m);
    expect(file).toContain('branch: task/T1-ship-it');
  });

  it('is published to the open pages, like every change of a task', async () => {
    const id = await createTask();

    await board.patch(`${API}/tasks/${id}`, { aiRun: { agent: 'x', state: 'working' } });

    expect(board.events.events.at(-1)).toMatchObject({
      type: 'task.updated',
      task: { id, aiRun: { agent: 'x', state: 'working' } },
    });
  });

  it('needs only the agent and the state: the rest is added as the run goes', async () => {
    const id = await createTask();
    const run = { agent: 'claude-code', state: 'working', startedAt: '2026-09-26T10:00:00Z' };

    const response = await board.patch(`${API}/tasks/${id}`, { aiRun: run }).expect(200);

    expect(response.body.aiRun).toEqual(run);
  });

  it('is removed by null', async () => {
    const id = await createTask();
    await board.patch(`${API}/tasks/${id}`, { aiRun: finished }).expect(200);

    const response = await board.patch(`${API}/tasks/${id}`, { aiRun: null }).expect(200);

    expect(response.body).not.toHaveProperty('aiRun');
  });

  it('refuses what the model does not know, and changes nothing (INVARIANT)', async () => {
    const id = await createTask();
    await board.patch(`${API}/tasks/${id}`, { aiRun: finished }).expect(200);

    for (const aiRun of [
      { state: 'finished' },
      { agent: 'claude-code' },
      { agent: '', state: 'working' },
      { agent: 'claude-code', state: 'done' },
      { ...finished, checks: 'green' },
      { ...finished, commit: 'HEAD' },
      { ...finished, commit: 'not a sha at all' },
      { ...finished, startedAt: 'yesterday' },
      { ...finished, finishedAt: '26.09.2026' },
      { ...finished, command: 'rm -rf /' },
      'finished',
    ]) {
      const response = await board.patch(`${API}/tasks/${id}`, { aiRun }).expect(400);
      expect(code(response.body)).toBe('INVALID_REQUEST');
    }
    expect((await board.get(`${API}/tasks/${id}`).expect(200)).body.aiRun).toEqual(finished);
  });

  it('is a change like any other: without the token, nothing is written', async () => {
    const id = await createTask();

    const response = await board
      .agent()
      .patch(`${API}/tasks/${id}`)
      .send({ aiRun: finished })
      .expect(401);

    expect(code(response.body)).toBe('UNAUTHORIZED');
    expect((await board.get(`${API}/tasks/${id}`).expect(200)).body).not.toHaveProperty('aiRun');
  });

  it('cannot be given when a task is created: a run is reported on a task that exists', async () => {
    const response = await board
      .post(`${API}/tasks`, { title: 'Ship it', aiRun: finished })
      .expect(400);
    expect(code(response.body)).toBe('INVALID_REQUEST');
  });
});
