import {
  API_BASE_PATH as API,
  errorResponseSchema,
  generateInstructions,
} from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { cleanTmpDirs } from '../support/tmp.js';

/**
 * HTTP API for the runner's begin/end lifecycle (T31).
 * These routes are not in the AI instructions and require the session token.
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

describe('POST /tasks/:id/ai-run (begin)', () => {
  it('requires the session token (INVARIANT)', async () => {
    const id = await createTask();
    const response = await board
      .agent()
      .post(`${API}/tasks/${id}/ai-run`)
      .send(BEGIN_BODY)
      .expect(401);
    expect(code(response.body)).toBe('UNAUTHORIZED');
  });

  it('returns the new aiRun with state: working and runId: 1', async () => {
    const id = await createTask();
    const response = await board.post(`${API}/tasks/${id}/ai-run`, BEGIN_BODY).expect(200);
    expect(response.body.runId).toBe(1);
    expect(response.body.state).toBe('working');
  });

  it('refuses unknown fields', async () => {
    const id = await createTask();
    const response = await board
      .post(`${API}/tasks/${id}/ai-run`, { ...BEGIN_BODY, extra: 'oops' })
      .expect(400);
    expect(code(response.body)).toBe('INVALID_REQUEST');
  });

  it('returns 409 AI_RUN_IN_PROGRESS when already working', async () => {
    const id = await createTask();
    await board.post(`${API}/tasks/${id}/ai-run`, BEGIN_BODY).expect(200);

    const response = await board
      .post(`${API}/tasks/${id}/ai-run`, {
        ...BEGIN_BODY,
        sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456790',
      })
      .expect(409);
    expect(code(response.body)).toBe('AI_RUN_IN_PROGRESS');
  });
});

describe('POST /tasks/:id/ai-run/:runId/end (end)', () => {
  it('requires the session token (INVARIANT)', async () => {
    const id = await createTask();
    await board.post(`${API}/tasks/${id}/ai-run`, BEGIN_BODY).expect(200);
    const response = await board
      .agent()
      .post(`${API}/tasks/${id}/ai-run/1/end`)
      .send({ exitCode: 0 })
      .expect(401);
    expect(code(response.body)).toBe('UNAUTHORIZED');
  });

  it('returns 409 STALE_AI_RUN for wrong runId', async () => {
    const id = await createTask();
    await board.post(`${API}/tasks/${id}/ai-run`, BEGIN_BODY).expect(200);

    const response = await board
      .post(`${API}/tasks/${id}/ai-run/0/end`, { exitCode: 0 })
      .expect(409);
    expect(code(response.body)).toBe('STALE_AI_RUN');
  });

  it('end with exitCode marks failed when state was working', async () => {
    const id = await createTask();
    await board.post(`${API}/tasks/${id}/ai-run`, BEGIN_BODY).expect(200);

    const response = await board
      .post(`${API}/tasks/${id}/ai-run/1/end`, { exitCode: 1 })
      .expect(200);
    expect(response.body.state).toBe('failed');
    expect(response.body.failure.kind).toBe('exit');
  });

  it('refuses unknown fields', async () => {
    const id = await createTask();
    await board.post(`${API}/tasks/${id}/ai-run`, BEGIN_BODY).expect(200);

    const response = await board
      .post(`${API}/tasks/${id}/ai-run/1/end`, { exitCode: 0, extra: 'oops' })
      .expect(400);
    expect(code(response.body)).toBe('INVALID_REQUEST');
  });
});

describe('routes absent from generateInstructions (INVARIANT)', () => {
  it('ai-run begin, end and report routes are not in the generated instructions', () => {
    const instructions = generateInstructions({
      baseUrl: 'http://127.0.0.1:7432/api/v1',
      token: 'tok',
      board: { name: 'board', statuses: ['backlog', 'done'], idPrefix: 'T' },
    });
    expect(instructions).not.toContain('/ai-run');
  });
});
