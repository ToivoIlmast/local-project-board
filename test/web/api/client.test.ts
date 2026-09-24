import { routes } from '../../../src/contract/v1/index';
import { ApiError, createBoardClient } from '../../../src/web/api/index';
import { errorBody, fakeFetch, type Reply } from '../support/fetch';
import { aDocument, aGitStatus, aProject, aReport, aTask } from '../support/fixtures';

const TOKEN = 'the-session-token';
const BASE = 'http://127.0.0.1:7432';

/** Answers the session route with a token and everything else with what the test says. */
function board(handler: (url: string, method: string) => Reply | undefined) {
  const fake = fakeFetch((call) => {
    if (call.url.endsWith('/api/v1/session')) return { json: { token: TOKEN } };
    return handler(call.url, call.method) ?? { status: 404, json: errorBody('NOT_FOUND') };
  });
  return { fake, client: createBoardClient({ baseUrl: BASE, fetch: fake.fetch }) };
}

describe('the board client speaks the contract', () => {
  it('reads the project from the path the contract declares', async () => {
    const { fake, client } = board((url) =>
      url === `${BASE}/api/v1/project` ? { json: aProject() } : undefined,
    );

    expect(await client.project()).toMatchObject({ name: 'dep-health', idPrefix: 'T' });
    expect(fake.calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/api/v1/project` });
  });

  it('puts parameters into the path and escapes them', async () => {
    const { fake, client } = board(() => ({ text: '# Plan\n' }));

    await client.readDocument('T12', 'notes/dev plan.md');

    expect(fake.urls()).toEqual([`${BASE}/api/v1/tasks/T12/documents/notes%2Fdev%20plan.md`]);
  });

  it('sends only the query parameters it was given', async () => {
    const { fake, client } = board(() => ({ json: { text: '@@ -1 +1 @@\n', truncated: false } }));

    await client.gitDiff({ path: 'src/a b.ts' });

    expect(fake.urls()).toEqual([`${BASE}/api/v1/git/diff?path=src%2Fa%20b.ts`]);
  });

  it('validates an answer against the contract and refuses to invent data (INVARIANT)', async () => {
    const { client } = board(() => ({ json: { name: 'dep-health' } }));

    await expect(client.project()).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  it('reads text routes as text, not as JSON', async () => {
    const { client } = board(() => ({ text: '# local-project-board API (v1)\n' }));

    expect(await client.instructions()).toBe('# local-project-board API (v1)\n');
  });

  it('answers a delete without a value once the server confirms it', async () => {
    const { fake, client } = board(() => ({ json: { deleted: true } }));

    await expect(client.deleteTask('T12')).resolves.toBeUndefined();
    expect(fake.calls.at(-1)).toMatchObject({ method: 'DELETE', url: `${BASE}/api/v1/tasks/T12` });
  });

  it('covers every route the UI needs with one code path', async () => {
    const answers: Record<string, Reply> = {
      'GET /api/v1/project': { json: aProject() },
      'GET /api/v1/tasks': { json: [aTask()] },
      'POST /api/v1/tasks': { json: aTask(), status: 201 },
      'GET /api/v1/tasks/T1': { json: aTask({ id: 'T1' }) },
      'PATCH /api/v1/tasks/T1': { json: aTask({ id: 'T1' }) },
      'POST /api/v1/tasks/T1/move': { json: aTask({ id: 'T1' }) },
      'DELETE /api/v1/tasks/T1': { json: { deleted: true } },
      'GET /api/v1/tasks/T1/documents': { json: [aDocument()] },
      'GET /api/v1/tasks/T1/documents/plan.md': { text: '# Plan\n' },
      'PUT /api/v1/tasks/T1/documents/plan.md': { json: aDocument() },
      'DELETE /api/v1/tasks/T1/documents/plan.md': { json: { deleted: true } },
      'GET /api/v1/reports': { json: [aReport()] },
      'GET /api/v1/reports/R1': { text: '<h1>Audit</h1>', contentType: 'text/html' },
      'DELETE /api/v1/reports/R1': { json: { deleted: true } },
      'GET /api/v1/git/status': { json: aGitStatus() },
      'GET /api/v1/git/commits?limit=10': { json: [] },
      'GET /api/v1/git/diff': { json: { text: '', truncated: false } },
      'GET /api/v1/instructions': { text: '# API\n' },
    };
    const { fake, client } = board((url, method) => answers[`${method} ${url.slice(BASE.length)}`]);

    await client.project();
    await client.listTasks();
    await client.createTask({ title: 'New' });
    await client.getTask('T1');
    await client.updateTask('T1', { title: 'Renamed' });
    await client.moveTask('T1', { status: 'done' });
    await client.deleteTask('T1');
    await client.listDocuments('T1');
    await client.readDocument('T1', 'plan.md');
    await client.writeDocument('T1', 'plan.md', '# Plan\n');
    await client.deleteDocument('T1', 'plan.md');
    await client.listReports();
    await client.readReport('R1');
    await client.deleteReport('R1');
    await client.gitStatus();
    await client.gitCommits(10);
    await client.gitDiff({});
    await client.instructions();

    // Every call above was answered; an unknown path would have been a 404 ApiError.
    expect(fake.calls.filter((call) => call.url.endsWith('/session'))).toHaveLength(1);
  });

  it('asks the running server for the paths instead of hard-coding them', () => {
    const { client } = board(() => undefined);

    expect(client.reportUrl('R3')).toBe(
      `${BASE}${'/api/v1'}${routes['reports.read'].path.replace(':id', 'R3')}`,
    );
    expect(client.eventsUrl()).toBe(`${BASE}/api/v1${routes['events.stream'].path}`);
  });
});

describe('the session token', () => {
  it('is sent with a change and fetched only once (INVARIANT)', async () => {
    const { fake, client } = board(() => ({ json: aTask(), status: 201 }));

    await client.createTask({ title: 'One' });
    await client.createTask({ title: 'Two' });

    const session = fake.calls.filter((call) => call.url.endsWith('/session'));
    expect(session).toHaveLength(1);
    const creates = fake.calls.filter((call) => call.method === 'POST');
    expect(creates).toHaveLength(2);
    for (const call of creates) expect(call.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('is not sent with a read: the board asks for it only where it changes something', async () => {
    const { fake, client } = board(() => ({ json: [aTask()] }));

    await client.listTasks();

    expect(fake.calls[0]?.headers['Authorization']).toBeUndefined();
  });

  it('never reaches a URL (INVARIANT)', async () => {
    const { fake, client } = board(() => ({ json: aTask(), status: 201 }));

    await client.createTask({ title: 'One' });
    await client.listTasks().catch(() => undefined);

    for (const url of fake.urls()) expect(url).not.toContain(TOKEN);
    expect(client.reportUrl('R1')).not.toContain(TOKEN);
    expect(client.eventsUrl()).not.toContain(TOKEN);
  });

  it('is fetched again when the board says it is no longer valid, and the change retried', async () => {
    let token = 'first-token';
    let attempts = 0;
    const fake = fakeFetch((call) => {
      if (call.url.endsWith('/session')) return { json: { token } };
      attempts += 1;
      if (call.headers['Authorization'] !== `Bearer ${token}`) {
        return { status: 401, json: errorBody('UNAUTHORIZED', 'This request must carry a token.') };
      }
      return { json: aTask(), status: 201 };
    });
    const client = createBoardClient({ baseUrl: BASE, fetch: fake.fetch });

    await client.createTask({ title: 'Before the restart' });
    // The board restarted: the token in hand is stale, and the page must recover by itself.
    token = 'second-token';
    const task = await client.createTask({ title: 'After the restart' });

    expect(task).toMatchObject({ title: expect.any(String) });
    expect(attempts).toBe(3);
    expect(fake.calls.filter((call) => call.url.endsWith('/session'))).toHaveLength(2);
  });

  it('gives up after one retry instead of asking forever', async () => {
    let attempts = 0;
    const fake = fakeFetch((call) => {
      if (call.url.endsWith('/session')) return { json: { token: TOKEN } };
      attempts += 1;
      // A client that kept retrying would hang the suite instead of failing it.
      if (attempts > 3) throw new Error('The client is still asking after three tries.');
      return { status: 401, json: errorBody('UNAUTHORIZED', 'This request must carry a token.') };
    });
    const client = createBoardClient({ baseUrl: BASE, fetch: fake.fetch });

    await expect(client.createTask({ title: 'Nope' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
    expect(fake.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });
});

describe('what the page is told when something goes wrong', () => {
  it('keeps the code, message and details the board sent', async () => {
    const { client } = board(() => ({
      status: 404,
      json: errorBody('TASK_NOT_FOUND', 'Task "T9" does not exist.', { id: 'T9' }),
    }));

    const error = await client.getTask('T9').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 404,
      code: 'TASK_NOT_FOUND',
      message: 'Task "T9" does not exist.',
      details: { id: 'T9' },
    });
  });

  it.each([
    [400, 'INVALID_REQUEST'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN_ORIGIN'],
    [409, 'INVALID_DOCUMENT_NAME'],
    [422, 'UNKNOWN_STATUS'],
  ])('passes a %s through as %s', async (status, code) => {
    const { client } = board(() => ({ status, json: errorBody(code, 'No.') }));

    await expect(client.listTasks()).rejects.toMatchObject({ status, code });
  });

  it('does not pretend a broken error body is a board error', async () => {
    const { client } = board(() => ({ status: 500, text: '<html>Internal Server Error</html>' }));

    const error = (await client.listTasks().catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('MALFORMED_RESPONSE');
    expect(error.status).toBe(500);
    expect(error.message).toContain('500');
  });

  it('says the board is not answering when the connection fails', async () => {
    const fake = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const client = createBoardClient({ baseUrl: BASE, fetch: fake.fetch });

    const error = (await client.listTasks().catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.status).toBe(0);
    expect(error.message).toMatch(/not answering|stopped/i);
  });
});
