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
 * How an agent gives the result of its work back to the board (T27, the model of T20, updated
 * in T32): the agent sends its report to the dedicated report route so it cannot overwrite
 * runner fields. PATCH aiRun now only accepts null (user cleanup).
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

const BEGIN_BODY = {
  sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
  mode: 'new',
  model: 'claude-sonnet-4-6',
};

const reportBody = {
  agent: 'claude-code',
  state: 'finished',
  checks: 'passed',
  commit: '9f1c1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b',
  finishedAt: '2026-09-26T11:00:00.000Z',
};

async function createTaskWithRun(): Promise<{ id: string; runId: number }> {
  const id = await createTask();
  const res = await board.post(`${API}/tasks/${id}/ai-run`, BEGIN_BODY).expect(200);
  return { id, runId: (res.body as { runId: number }).runId };
}

describe('aiRun: the result of an agent via the report route (T27 updated in T32)', () => {
  it('report takes agent fields and the task carries the full run', async () => {
    const { id, runId } = await createTaskWithRun();

    const response = await board
      .patch(`${API}/tasks/${id}/ai-run/${runId}/report`, reportBody)
      .expect(200);

    const aiRun = taskSchema.parse(response.body).aiRun;
    expect(aiRun?.agent).toBe('claude-code');
    expect(aiRun?.state).toBe('finished');
    expect(aiRun?.checks).toBe('passed');
    expect(aiRun?.commit).toBe('9f1c1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b');
    // runner fields are preserved
    expect(aiRun?.sessionId).toBe(BEGIN_BODY.sessionId);
    expect(aiRun?.runId).toBe(runId);
    expect((await board.get(`${API}/tasks/${id}`).expect(200)).body.aiRun?.state).toBe('finished');
  });

  it('the run is written into the file of the task, next to the branch', async () => {
    const { id, runId } = await createTaskWithRun();
    await board.patch(`${API}/tasks/${id}`, { branch: 'task/T1-ship-it' }).expect(200);
    await board.patch(`${API}/tasks/${id}/ai-run/${runId}/report`, reportBody).expect(200);

    const file = await readFile(join(board.root, '.board', 'tasks', id, 'task.md'), 'utf8');
    expect(file).toMatch(/^aiRun:\n {2}agent: claude-code\n {2}state: finished\n/m);
    expect(file).toContain('branch: task/T1-ship-it');
  });

  it('is published to the open pages, like every change of a task', async () => {
    const { id, runId } = await createTaskWithRun();

    await board.patch(`${API}/tasks/${id}/ai-run/${runId}/report`, reportBody).expect(200);

    expect(board.events.events.at(-1)).toMatchObject({
      type: 'task.updated',
      task: { id, aiRun: { state: 'finished' } },
    });
  });

  it('is removed by null via PATCH (user cleanup)', async () => {
    const { id, runId } = await createTaskWithRun();
    await board.patch(`${API}/tasks/${id}/ai-run/${runId}/report`, reportBody).expect(200);

    const response = await board.patch(`${API}/tasks/${id}`, { aiRun: null }).expect(200);

    expect(response.body).not.toHaveProperty('aiRun');
  });

  it('PATCH aiRun with an object is rejected — use the report route (INVARIANT)', async () => {
    const id = await createTask();

    for (const aiRun of [
      { agent: 'claude-code', state: 'working' },
      { agent: 'claude-code', state: 'finished' },
      { agent: 'x', state: 'working', startedAt: '2026-09-26T10:00:00Z' },
      'finished',
    ]) {
      const response = await board.patch(`${API}/tasks/${id}`, { aiRun }).expect(400);
      expect(code(response.body)).toBe('INVALID_REQUEST');
    }
    expect((await board.get(`${API}/tasks/${id}`).expect(200)).body).not.toHaveProperty('aiRun');
  });

  it('report requires the token: without it nothing is written', async () => {
    const { id, runId } = await createTaskWithRun();

    const response = await board
      .agent()
      .patch(`${API}/tasks/${id}/ai-run/${runId}/report`)
      .send(reportBody)
      .expect(401);

    expect(code(response.body)).toBe('UNAUTHORIZED');
    expect((await board.get(`${API}/tasks/${id}`).expect(200)).body.aiRun?.state).toBe('working');
  });

  it('cannot be given when a task is created: a run is reported on a task that exists', async () => {
    const response = await board
      .post(`${API}/tasks`, { title: 'Ship it', aiRun: { agent: 'x', state: 'working' } })
      .expect(400);
    expect(code(response.body)).toBe('INVALID_REQUEST');
  });
});
