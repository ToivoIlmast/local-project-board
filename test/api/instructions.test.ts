import {
  API_BASE_PATH as API,
  errorResponseSchema,
  routeList,
  routes,
} from '../../src/contract/v1/index.js';
import { createTestBoard, STATUSES, type TestBoard } from '../support/httpBoard.js';
import { captureConsole, type CapturedConsole } from '../support/logs.js';
import { cleanTmpDirs } from '../support/tmp.js';

let board: TestBoard;
/** Everything the server printed while the test ran; the token must be in none of it. */
let logs: CapturedConsole;

beforeEach(async () => {
  // In place before the server starts, so that starting it cannot print the token either.
  logs = captureConsole();
  board = await createTestBoard();
});

afterEach(async () => {
  logs.restore();
  await board.close();
  await cleanTmpDirs();
});

const code = (body: unknown): string => errorResponseSchema.parse(body).error.code;

describe('GET /api/v1/instructions', () => {
  it('answers with the generated markdown', async () => {
    const response = await board.get(`${API}/instructions`).expect(200);

    expect(response.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text.startsWith('# ')).toBe(true);
  });

  it('needs no token, because an agent has nothing else to start from', async () => {
    // The same request without a token against a mutation is refused; a read is not.
    await board.agent().get(`${API}/instructions`).expect(200);
    await board.agent().post(`${API}/tasks`).send({ title: 'x' }).expect(401);
  });

  it('carries this run token and the live base URL (INVARIANT)', async () => {
    const response = await board.get(`${API}/instructions`).expect(200);

    expect(response.text).toContain(`Authorization: Bearer ${board.token}`);
    expect(response.text).toContain(`Base URL: http://127.0.0.1:${board.port}${API}`);
  });

  it('describes the board it is actually serving, not a generic one', async () => {
    const response = await board.get(`${API}/instructions`).expect(200);

    expect(response.text).toContain(STATUSES.join(', '));
    expect(response.text).toContain('test-board');
  });

  it('follows the statuses this board is configured with, not the ones in the examples', async () => {
    const custom = await createTestBoard({ statuses: ['idea', 'doing', 'shipped'] });
    try {
      const text = (await custom.get(`${API}/instructions`).expect(200)).text;
      expect(text).toContain('idea, doing, shipped');
      expect(text).not.toContain(STATUSES.join(', '));
    } finally {
      await custom.close();
    }
  });

  it('documents every route an agent may use and no route it may not', async () => {
    const response = await board.get(`${API}/instructions`).expect(200);

    for (const route of routeList) {
      const heading = `### ${route.method} ${API}${route.path}`;
      expect(response.text.includes(heading)).toBe(route.ai.include);
    }
    expect(routes['instructions.get'].ai.include).toBe(false);
  });

  it('lists the error codes the board really answers with', async () => {
    const text = (await board.get(`${API}/instructions`).expect(200)).text;

    const unknownTask = await board.get(`${API}/tasks/T99`).expect(404);
    const badStatus = await board.post(`${API}/tasks`, { title: 'x', status: 'nope' }).expect(422);
    const noToken = await board.agent().post(`${API}/tasks`).send({ title: 'x' }).expect(401);
    const badBody = await board.post(`${API}/tasks`, { title: '' }).expect(400);

    for (const response of [unknownTask, badStatus, noToken, badBody]) {
      expect(text).toContain(code(response.body));
    }
  });

  it('is refused to a foreign page and to a rebound host', async () => {
    const foreignOrigin = await board
      .agent()
      .get(`${API}/instructions`)
      .set('Origin', 'http://evil.com');
    const foreignHost = await board
      .agent()
      .get(`${API}/instructions`)
      .set('Host', `evil.com:${board.port}`);

    expect(foreignOrigin.status).toBe(403);
    expect(code(foreignOrigin.body)).toBe('FORBIDDEN_ORIGIN');
    expect(foreignOrigin.text).not.toContain(board.token);
    expect(foreignHost.status).toBe(403);
    expect(code(foreignHost.body)).toBe('FORBIDDEN_HOST');
    expect(foreignHost.text).not.toContain(board.token);
  });

  it('never logs the token, however the request ends (INVARIANT)', async () => {
    await board.get(`${API}/instructions`).expect(200);
    await board.get(`${API}/session`).expect(200);
    await board.agent().get(`${API}/instructions`).set('Origin', 'http://evil.com').expect(403);
    await board.agent().post(`${API}/tasks`).send({ title: 'x' }).expect(401);

    expect(logs.text()).not.toContain(board.token);
    expect(JSON.stringify(board.internalErrors)).not.toContain(board.token);
  });

  it('keeps the token out of the headers it answers with', async () => {
    const response = await board.get(`${API}/instructions`).expect(200);
    expect(JSON.stringify(response.headers)).not.toContain(board.token);
  });

  it('is served under the versioned path only', async () => {
    await board.get('/api/instructions').expect(404);
    await board.get('/instructions').expect(404);
  });

  it('takes no method but GET', async () => {
    const response = await board.post(`${API}/instructions`, {});
    expect(response.status).toBe(405);
    expect(response.headers['allow']).toBe('GET');
  });
});
