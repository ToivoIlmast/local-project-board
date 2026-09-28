import {
  API_BASE_PATH as API,
  errorResponseSchema,
  taskSchema,
} from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { cleanTmpDirs } from '../support/tmp.js';

/**
 * PATCH /tasks/:id/ai-run/:runId/report: the agent reports its run result through a dedicated
 * route so it cannot overwrite runner fields (T32).
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

const BEGIN_BODY = {
  sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
  mode: 'new',
  model: 'claude-sonnet-4-6',
};

async function createTask(): Promise<string> {
  const response = await board.post(`${API}/tasks`, { title: 'Ship it' }).expect(201);
  return (response.body as { id: string }).id;
}

async function createTaskWithRun(): Promise<{ id: string; runId: number }> {
  const id = await createTask();
  const res = await board.post(`${API}/tasks/${id}/ai-run`, BEGIN_BODY).expect(200);
  return { id, runId: (res.body as { runId: number }).runId };
}

const finishedReport = {
  agent: 'claude-code',
  state: 'finished',
  checks: 'passed',
  commit: '9f1c1a2b3c4d5e6f',
  finishedAt: '2026-09-28T10:00:00.000Z',
};

describe('PATCH /tasks/:id/ai-run/:runId/report (T32)', () => {
  it('accepts agent fields and returns the updated task (INVARIANT)', async () => {
    const { id, runId } = await createTaskWithRun();

    const response = await board
      .patch(`${API}/tasks/${id}/ai-run/${runId}/report`, finishedReport)
      .expect(200);

    const task = taskSchema.parse(response.body);
    expect(task.aiRun?.state).toBe('finished');
    expect(task.aiRun?.checks).toBe('passed');
    expect(task.aiRun?.commit).toBe('9f1c1a2b3c4d5e6f');
    // runner fields preserved
    expect(task.aiRun?.sessionId).toBe(BEGIN_BODY.sessionId);
    expect(task.aiRun?.runId).toBe(runId);
  });

  it('requires the session token (INVARIANT)', async () => {
    const { id, runId } = await createTaskWithRun();

    const response = await board
      .agent()
      .patch(`${API}/tasks/${id}/ai-run/${runId}/report`)
      .send(finishedReport)
      .expect(401);

    expect(code(response.body)).toBe('UNAUTHORIZED');
  });

  it('rejects runner-owned fields so the agent cannot overwrite identity (INVARIANT)', async () => {
    const { id, runId } = await createTaskWithRun();

    for (const extra of [
      { runId: 99 },
      { sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789' },
      { mode: 'new' },
      { model: 'gpt-4' },
      { startedAt: '2026-09-28T00:00:00Z' },
      { endedAt: '2026-09-28T10:00:00Z' },
    ]) {
      const response = await board
        .patch(`${API}/tasks/${id}/ai-run/${runId}/report`, { ...finishedReport, ...extra })
        .expect(400);
      expect(code(response.body)).toBe('INVALID_REQUEST');
    }
  });

  it('rejects `failure.kind` so the agent cannot forge launch/exit failures (INVARIANT)', async () => {
    const { id, runId } = await createTaskWithRun();

    const response = await board
      .patch(`${API}/tasks/${id}/ai-run/${runId}/report`, {
        agent: 'claude-code',
        state: 'failed',
        message: 'something went wrong',
        failure: { kind: 'launch', message: 'oops' },
      })
      .expect(400);

    expect(code(response.body)).toBe('INVALID_REQUEST');
  });

  it('returns 409 STALE_AI_RUN when runId is not the current one', async () => {
    const { id } = await createTaskWithRun();

    const response = await board
      .patch(`${API}/tasks/${id}/ai-run/0/report`, finishedReport)
      .expect(409);

    expect(code(response.body)).toBe('STALE_AI_RUN');
  });

  it('returns 409 when the state is already final and cannot be finalized again', async () => {
    const { id, runId } = await createTaskWithRun();
    await board.patch(`${API}/tasks/${id}/ai-run/${runId}/report`, finishedReport).expect(200);

    const response = await board
      .patch(`${API}/tasks/${id}/ai-run/${runId}/report`, {
        ...finishedReport,
        state: 'needs-review',
      })
      .expect(409);

    expect(code(response.body)).toBe('AI_RUN_ALREADY_FINAL');
  });

  it('writes failure.kind = agent when state is failed', async () => {
    const { id, runId } = await createTaskWithRun();

    const response = await board
      .patch(`${API}/tasks/${id}/ai-run/${runId}/report`, {
        agent: 'claude-code',
        state: 'failed',
        message: 'checks did not pass',
      })
      .expect(200);

    expect(response.body.aiRun?.failure?.kind).toBe('agent');
    expect(response.body.aiRun?.failure?.message).toBe('checks did not pass');
    // The task file stays unchanged after a stale-runId rejection
    const fresh = await board.get(`${API}/tasks/${id}`).expect(200);
    expect(fresh.body.aiRun?.failure?.kind).toBe('agent');
  });

  it('file is not modified on a stale-runId rejection (INVARIANT)', async () => {
    const { id } = await createTaskWithRun();
    const before = (await board.get(`${API}/tasks/${id}`).expect(200)).body;

    await board.patch(`${API}/tasks/${id}/ai-run/0/report`, finishedReport).expect(409);

    const after = (await board.get(`${API}/tasks/${id}`).expect(200)).body;
    expect(after).toEqual(before);
  });

  it('refuses state: working (only final states are valid for a report)', async () => {
    const { id, runId } = await createTaskWithRun();

    const response = await board
      .patch(`${API}/tasks/${id}/ai-run/${runId}/report`, {
        agent: 'claude-code',
        state: 'working',
      })
      .expect(400);

    expect(code(response.body)).toBe('INVALID_REQUEST');
  });
});
