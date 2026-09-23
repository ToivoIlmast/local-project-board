import {
  API_BASE_PATH as API,
  errorResponseSchema,
  routeList,
  routes,
  sessionSchema,
} from '../../src/contract/v1/index.js';
import { createTestBoard, createWebRoot, type TestBoard } from '../support/httpBoard.js';
import { cleanTmpDirs } from '../support/tmp.js';

let board: TestBoard;

beforeEach(async () => {
  board = await createTestBoard();
});

afterEach(async () => {
  await board.close();
  await cleanTmpDirs();
});

const code = (body: unknown): string => errorResponseSchema.parse(body).error.code;

describe('GET /api/v1/session', () => {
  it('is part of the contract', () => {
    expect(routes['session.get']).toMatchObject({ method: 'GET', path: '/session' });
  });

  it('answers with this run token and with nothing else (INVARIANT)', async () => {
    const response = await board.get(`${API}/session`).expect(200);

    expect(response.headers['content-type']).toContain('application/json');
    expect(sessionSchema.parse(response.body)).toEqual({ token: board.token });
    // A strict schema would accept extra keys nowhere, but the answer is checked as it is sent.
    expect(Object.keys(response.body as object)).toEqual(['token']);
  });

  it('hands the page a token that really opens the API', async () => {
    const { token } = sessionSchema.parse((await board.get(`${API}/session`).expect(200)).body);

    await board
      .agent()
      .post(`${API}/tasks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'created with the token the page was given' })
      .expect(201);
  });

  it('is not cached, so a restarted board is never answered from the disk cache', async () => {
    const response = await board.get(`${API}/session`).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('is refused to a foreign page and to a rebound host (INVARIANT)', async () => {
    const foreignOrigin = await board
      .agent()
      .get(`${API}/session`)
      .set('Origin', 'http://evil.com');
    const foreignHost = await board
      .agent()
      .get(`${API}/session`)
      .set('Host', `evil.com:${board.port}`);

    expect(foreignOrigin.status).toBe(403);
    expect(code(foreignOrigin.body)).toBe('FORBIDDEN_ORIGIN');
    expect(foreignOrigin.text).not.toContain(board.token);
    expect(foreignHost.status).toBe(403);
    expect(code(foreignHost.body)).toBe('FORBIDDEN_HOST');
    expect(foreignHost.text).not.toContain(board.token);
  });

  it('is served to the board own page', async () => {
    const response = await board.agent().get(`${API}/session`).set('Origin', board.origin);
    expect(response.status).toBe(200);
  });

  it('is reachable only under the versioned path', async () => {
    await board.get('/api/session').expect(404);
    await board.get('/session').expect(404);
  });

  it('takes no method but GET', async () => {
    const response = await board.post(`${API}/session`, {});
    expect(response.status).toBe(405);
    expect(response.headers['allow']).toBe('GET');
  });
});

describe('the token on the wire', () => {
  it('is returned by the session and the instructions, and by no other route (INVARIANT)', async () => {
    await board.post(`${API}/tasks`, { title: 'a' }).expect(201);
    await board.put(`${API}/tasks/T1/documents/plan.md`, { content: '# Plan\n' }).expect(200);
    await board.post(`${API}/reports`, { title: 'r', format: 'md', content: '# R\n' }).expect(201);

    const paths: Record<string, string> = {
      'project.get': '/project',
      'tasks.list': '/tasks',
      'tasks.get': '/tasks/T1',
      'documents.list': '/tasks/T1/documents',
      'documents.read': '/tasks/T1/documents/plan.md',
      'git.status': '/git/status',
      'git.branches': '/git/branches',
      'git.commits': '/git/commits',
      'git.diff': '/git/diff',
      'reports.list': '/reports',
      'reports.read': '/reports/R1',
      'session.get': '/session',
      'instructions.get': '/instructions',
    };
    // Every readable route is covered: a new one cannot slip past this sweep unnoticed.
    const readable = routeList
      .filter((r) => r.method === 'GET' && r.response.media !== 'text/event-stream')
      .map((r) => r.id);
    expect(Object.keys(paths).sort()).toEqual(readable.sort());

    for (const [id, path] of Object.entries(paths)) {
      const response = await board.get(`${API}${path}`).expect(200);
      const carriesToken = id === 'session.get' || id === 'instructions.get';
      expect([id, response.text.includes(board.token)]).toEqual([id, carriesToken]);
      expect(JSON.stringify(response.headers)).not.toContain(board.token);
    }
  });

  it('is never read from the URL, on the session route either', async () => {
    const response = await board.agent().post(`${API}/tasks?token=${board.token}`).send({
      title: 'x',
    });
    expect(response.status).toBe(401);
    expect(await board.storage.listTasks()).toEqual([]);
  });

  it('is not in the page the browser loads', async () => {
    const spa = await createTestBoard({ webRoot: await createWebRoot() });
    try {
      const page = await spa.get('/').expect(200);
      expect(page.text).not.toContain(spa.token);
      // The page gets it the only way it may: by asking for it.
      const session = await spa.agent().get(`${API}/session`).set('Origin', spa.origin).expect(200);
      expect(sessionSchema.parse(session.body).token).toBe(spa.token);
    } finally {
      await spa.close();
    }
  });
});
