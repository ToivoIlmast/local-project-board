import { API_BASE_PATH as API, errorResponseSchema } from '../../src/contract/v1/index.js';
import type { Storage } from '../../src/core/ports.js';
import { createMemoryStore, inMemoryStorage } from '../support/inMemoryStorage.js';
import { createTestBoard, createWebRoot, type TestBoard } from '../support/httpBoard.js';
import { cleanTmpDirs } from '../support/tmp.js';

let board: TestBoard;

afterEach(async () => {
  await board.close();
  await cleanTmpDirs();
});

describe('HTTP errors', () => {
  beforeEach(async () => {
    board = await createTestBoard();
  });

  it('answers 404 in the contract error format for a route that does not exist', async () => {
    const response = await board.get(`${API}/nope`).expect(404);
    expect(errorResponseSchema.parse(response.body).error.code).toBe('NOT_FOUND');
    expect(response.headers['content-type']).toMatch(/^application\/json/);
  });

  it('answers 405 with the methods the route does have', async () => {
    const response = await board.post(`${API}/tasks/T1`, {}).expect(405);
    expect(errorResponseSchema.parse(response.body).error.code).toBe('METHOD_NOT_ALLOWED');
    expect((response.headers['allow'] ?? '').split(/,\s*/).sort()).toEqual([
      'DELETE',
      'GET',
      'PATCH',
    ]);
  });

  it('answers 400 for a body that is not JSON', async () => {
    const response = await board
      .agent()
      .post(`${API}/tasks`)
      .set('Authorization', `Bearer ${board.token}`)
      .set('Content-Type', 'application/json')
      .send('{"title": ');
    expect(response.status).toBe(400);
    expect(errorResponseSchema.parse(response.body).error.code).toBe('INVALID_JSON');
  });

  it('answers 413 instead of reading an unbounded body', async () => {
    const response = await board.post(`${API}/tasks`, {
      title: 'x',
      body: 'y'.repeat(4_000_000),
    });
    expect(response.status).toBe(413);
    expect(errorResponseSchema.parse(response.body).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('answers 400 for a percent-encoding the URL cannot be decoded from', async () => {
    const response = await board.get(`${API}/tasks/T1/documents/%E0%A4%A`);
    expect(response.status).toBe(400);
    expect(errorResponseSchema.parse(response.body).error.code).toBe('INVALID_REQUEST');
  });

  it('tells the client nothing about the inside of the server', async () => {
    const response = await board.get(`${API}/tasks/T99`).expect(404);
    const text = response.text;
    expect(text).not.toContain(board.root);
    expect(text).not.toContain('node_modules');
    expect(text).not.toMatch(/\n\s+at /);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('a failure inside the server', () => {
  beforeEach(async () => {
    const store = createMemoryStore();
    const storage: Storage = {
      ...inMemoryStorage(store),
      listTasks: () =>
        Promise.reject(new Error("ENOENT: no such file, open '/home/me/private/.board/tasks'")),
    };
    board = await createTestBoard({ storage });
  });

  it('answers 500 without the message, the path or a stack, and logs it instead', async () => {
    const response = await board.get(`${API}/tasks`).expect(500);

    const { error } = errorResponseSchema.parse(response.body);
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(response.text).not.toContain('/home/me/private');
    expect(response.text).not.toContain('ENOENT');
    expect(response.text).not.toMatch(/\n\s+at /);
    expect(board.internalErrors).toHaveLength(1);
    expect((board.internalErrors[0] as Error).message).toContain('ENOENT');
  });
});

describe('the API next to the SPA', () => {
  beforeEach(async () => {
    board = await createTestBoard({ webRoot: await createWebRoot() });
  });

  it('serves the SPA for a client route', async () => {
    const page = await board.get('/task/T1').expect(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.text).toContain('<div id="root">');
  });

  it('never answers an API path with the SPA, whatever version is asked for', async () => {
    for (const path of [`${API}/nope`, '/api/v2/tasks', '/api/tasks', '/api']) {
      const response = await board.get(path);
      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(errorResponseSchema.parse(response.body).error.code).toBe('NOT_FOUND');
    }
  });
});
