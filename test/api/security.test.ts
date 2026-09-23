import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { API_BASE_PATH as API, errorResponseSchema } from '../../src/contract/v1/index.js';
import { createSessionToken } from '../../src/server/http/security.js';
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

/** One directive of a policy, so an assertion names the whole of it and not a substring. */
function directive(policy: string | undefined, name: string): string | undefined {
  return (policy ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
}

/** A request no HTTP client library would send: HTTP/1.0 without a Host header. */
function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request));
    let answer = '';
    socket.setTimeout(5_000, () => socket.destroy(new Error('timed out')));
    socket.on('data', (chunk) => (answer += chunk.toString()));
    socket.on('error', reject);
    socket.on('close', () => resolve(answer));
  });
}

describe('the Host header', () => {
  it('accepts only the loopback names of this very board', async () => {
    await board.agent().get(`${API}/tasks`).set('Host', `localhost:${board.port}`).expect(200);
    await board.agent().get(`${API}/tasks`).set('Host', `127.0.0.1:${board.port}`).expect(200);
    // A host name is case-insensitive, so refusing this one would refuse a legitimate client.
    await board.agent().get(`${API}/tasks`).set('Host', `LocalHost:${board.port}`).expect(200);
  });

  it('rejects a name that resolves to the loopback from somewhere else', async () => {
    for (const host of [
      `evil.com:${board.port}`,
      `127.0.0.1.evil.com:${board.port}`,
      `localhost.evil.com:${board.port}`,
      '127.0.0.1',
      `127.0.0.1:${board.port + 1}`,
      `[::1]:${board.port}`,
    ]) {
      const response = await board.agent().get(`${API}/tasks`).set('Host', host);
      expect(response.status).toBe(403);
      expect(code(response.body)).toBe('FORBIDDEN_HOST');
    }
  });

  it('rejects a mutation with a foreign Host even when the token is right', async () => {
    const response = await board
      .agent()
      .post(`${API}/tasks`)
      .set('Host', `evil.com:${board.port}`)
      .set('Authorization', `Bearer ${board.token}`)
      .send({ title: 'x' });
    expect(response.status).toBe(403);
    expect(await board.storage.listTasks()).toEqual([]);
  });

  it('rejects a request that carries no Host at all', async () => {
    const answer = await rawRequest(board.port, `GET ${API}/tasks HTTP/1.0\r\n\r\n`);
    expect(answer).toMatch(/^HTTP\/1\.1 403 /);
    expect(answer).toContain('FORBIDDEN_HOST');
  });
});

describe('the Origin header', () => {
  it('accepts a request with no Origin, as curl and agents send it', async () => {
    await board.get(`${API}/tasks`).expect(200);
    await board.post(`${API}/tasks`, { title: 'from an agent' }).expect(201);
  });

  it("accepts the board's own origin", async () => {
    for (const origin of [
      board.origin,
      `http://localhost:${board.port}`,
      `http://LOCALHOST:${board.port}`,
    ]) {
      await board.agent().get(`${API}/tasks`).set('Origin', origin).expect(200);
    }
  });

  it('rejects any other page, for reads as well as for mutations', async () => {
    for (const origin of [
      'http://evil.com',
      'https://evil.com',
      `https://127.0.0.1:${board.port}`,
      `http://127.0.0.1:${board.port + 1}`,
      'http://127.0.0.1.evil.com',
      'null',
      'http://localhost',
    ]) {
      const read = await board.agent().get(`${API}/tasks`).set('Origin', origin);
      expect(read.status).toBe(403);
      expect(code(read.body)).toBe('FORBIDDEN_ORIGIN');

      const write = await board
        .agent()
        .post(`${API}/tasks`)
        .set('Origin', origin)
        .set('Authorization', `Bearer ${board.token}`)
        .send({ title: 'x' });
      expect(write.status).toBe(403);
    }
    expect(await board.storage.listTasks()).toEqual([]);
  });
});

describe('the session token', () => {
  it('is required by every mutation and by no read', async () => {
    await board.get(`${API}/tasks`).expect(200);
    await board.get(`${API}/project`).expect(200);

    const created = await board.post(`${API}/tasks`, { title: 'a' }).expect(201);
    const id = (created.body as { id: string }).id;

    for (const call of [
      board.agent().post(`${API}/tasks`).send({ title: 'x' }),
      board.agent().patch(`${API}/tasks/${id}`).send({ title: 'x' }),
      board.agent().post(`${API}/tasks/${id}/move`).send({ status: 'done' }),
      board.agent().put(`${API}/tasks/${id}/documents/plan.md`).send({ content: 'x' }),
      board.agent().delete(`${API}/tasks/${id}`),
      board.agent().post(`${API}/reports`).send({ title: 'x', format: 'md', content: 'x' }),
    ]) {
      const response = await call;
      expect(response.status).toBe(401);
      expect(code(response.body)).toBe('UNAUTHORIZED');
    }

    expect((await board.storage.listTasks()).map((task) => task.title)).toEqual(['a']);
    expect(await board.storage.listReports()).toEqual([]);
  });

  it('is accepted only as a Bearer credential of exactly the right value', async () => {
    const attempts = [
      `Bearer ${board.token}x`,
      `Bearer ${board.token.slice(0, -1)}`,
      `Bearer ${board.token.toUpperCase()}`,
      board.token,
      `Basic ${board.token}`,
      'Bearer ',
    ];
    for (const authorization of attempts) {
      const response = await board
        .agent()
        .post(`${API}/tasks`)
        .set('Authorization', authorization)
        .send({ title: 'x' });
      expect(response.status).toBe(401);
    }
    expect(await board.storage.listTasks()).toEqual([]);

    // The scheme name is case-insensitive (RFC 7235); the credential is not.
    await board
      .agent()
      .post(`${API}/tasks`)
      .set('Authorization', `bearer ${board.token}`)
      .send({ title: 'x' })
      .expect(201);
  });

  it('is never taken from the URL', async () => {
    const response = await board
      .agent()
      .post(`${API}/tasks?token=${board.token}`)
      .send({ title: 'x' });
    expect(response.status).toBe(401);
    expect(await board.storage.listTasks()).toEqual([]);
  });

  it('never appears in an answer the board gives', async () => {
    await board.post(`${API}/tasks`, { title: 'a' }).expect(201);
    await board.post(`${API}/reports`, { title: 'r', format: 'md', content: 'x' }).expect(201);

    for (const path of [
      `${API}/project`,
      `${API}/tasks`,
      `${API}/tasks/T1`,
      `${API}/reports`,
      `${API}/git/status`,
      `${API}/tasks/T99`,
      `${API}/nope`,
    ]) {
      const response = await board.get(path);
      expect(response.text ?? '').not.toContain(board.token);
      expect(JSON.stringify(response.headers)).not.toContain(board.token);
    }
  });
});

describe('a malicious page that knows the board is running', () => {
  it('cannot create a task with a form post', async () => {
    const response = await board
      .agent()
      .post(`${API}/tasks`)
      .set('Origin', 'http://evil.com')
      .set('Content-Type', 'text/plain')
      .send('{"title":"pwned"}');

    expect(response.status).toBe(403);
    expect(await board.storage.listTasks()).toEqual([]);
  });

  it('cannot delete a task even when it guesses the id and sends no Origin', async () => {
    await board.post(`${API}/tasks`, { title: 'a' }).expect(201);
    const response = await board.agent().delete(`${API}/tasks/T1`);
    expect(response.status).toBe(401);
    expect(await board.storage.getTask('T1')).toMatchObject({ id: 'T1', title: 'a' });
  });
});

describe('security headers', () => {
  it('sends the ones an API answer needs and nothing that identifies the server', async () => {
    const response = await board.get(`${API}/tasks`).expect(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(directive(response.headers['content-security-policy'], 'default-src')).toBe(
      "default-src 'none'",
    );
    expect(directive(response.headers['content-security-policy'], 'frame-ancestors')).toBe(
      "frame-ancestors 'none'",
    );
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['server']).toBeUndefined();
  });

  it('keeps an HTML report out of the application: sandboxed, offline, unable to be the parent', async () => {
    const created = await board.post(`${API}/reports`, {
      title: 'Audit',
      format: 'html',
      content: '<h1>A</h1><script>fetch("/api/v1/tasks")</script>',
    });
    const id = (created.body as { id: string }).id;

    const response = await board.get(`${API}/reports/${id}`).expect(200);
    const csp = response.headers['content-security-policy'] ?? '';

    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(directive(csp, 'sandbox')).toBe('sandbox allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(directive(csp, 'default-src')).toBe("default-src 'none'");
    expect(directive(csp, 'connect-src')).toBe("connect-src 'none'");
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'self'");
  });

  it('gives an HTML document the same treatment as an HTML report', async () => {
    await board.post(`${API}/tasks`, { title: 'a' }).expect(201);
    await board.put(`${API}/tasks/T1/documents/report.html`, { content: '<h1>A</h1>' }).expect(200);

    const response = await board.get(`${API}/tasks/T1/documents/report.html`).expect(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(directive(response.headers['content-security-policy'], 'sandbox')).toBe(
      'sandbox allow-scripts',
    );
  });
});

describe('the shape of a request body', () => {
  it('is JSON on a JSON route, whatever else the request brings', async () => {
    // Everything else about this request is right: the token is valid and no page sent it.
    // A body that is not declared as JSON is still not JSON, and is not parsed as if it were.
    const response = await board
      .agent()
      .post(`${API}/tasks`)
      .set('Authorization', `Bearer ${board.token}`)
      .set('Content-Type', 'text/plain')
      .send('{"title":"through the back door"}');

    expect(response.status).toBe(400);
    expect(code(response.body)).toBe('INVALID_REQUEST');
    expect(await board.storage.listTasks()).toEqual([]);
  });
});

describe('the session token itself', () => {
  it('is long and different every time the board starts', () => {
    const tokens = Array.from({ length: 5 }, () => createSessionToken());
    expect(new Set(tokens).size).toBe(5);
    for (const value of tokens) {
      expect(value.length).toBeGreaterThanOrEqual(40);
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe('the application page', () => {
  it('is locked to its own origin and carries no token', async () => {
    const spa = await createTestBoard({ webRoot: await createWebRoot() });
    try {
      const page = await spa.get('/').expect(200);
      const csp = page.headers['content-security-policy'] ?? '';

      // A client route is served the same page, so it needs the same policy.
      const route = await spa.get('/task/T1').expect(200);
      expect(route.headers['content-security-policy']).toBe(csp);

      // The page itself is refused to a rebound name, not only the API under it.
      const rebound = await spa.agent().get('/').set('Host', `evil.com:${spa.port}`);
      expect(rebound.status).toBe(403);

      expect(directive(csp, 'default-src')).toBe("default-src 'self'");
      expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
      expect(directive(csp, 'object-src')).toBe("object-src 'none'");
      expect(directive(csp, 'base-uri')).toBe("base-uri 'none'");
      // A report is framed by the page, so scripts of the page itself stay at 'self'.
      expect(directive(csp, 'script-src')).toBe("script-src 'self'");
      expect(directive(csp, 'frame-src')).toBe("frame-src 'self'");
      expect(page.headers['x-content-type-options']).toBe('nosniff');
      expect(page.text).not.toContain(spa.token);
    } finally {
      await spa.close();
    }
  });
});

describe('the server boundary', () => {
  it('binds the loopback interface and offers no way to change it', async () => {
    const main = await readFile(
      fileURLToPath(new URL('../../src/server/cli/main.ts', import.meta.url)),
      'utf8',
    );
    expect(main).toContain("const HOST = '127.0.0.1'");
    expect(main).not.toMatch(/0\.0\.0\.0/);
    expect(main).not.toMatch(/['"]?host['"]?\s*:\s*\{\s*type/);
  });
});
