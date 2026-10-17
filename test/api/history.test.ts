import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  API_BASE_PATH as API,
  checkSchema,
  contentHash,
  errorResponseSchema,
  routeList,
  runRequestSchema,
  routes,
  taskVersionSchema,
  versionListSchema,
  type RunRequest,
} from '../../src/contract/v1/index.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { openStream, type SseClient } from '../support/sse.js';
import { cleanTmpDirs } from '../support/tmp.js';

/**
 * The history of a task over HTTP (T46, ADR-0030): versions of its content, restore, the
 * actuality check and the decisions on its recommendations.
 */

let board: TestBoard;
const open: SseClient<RunRequest>[] = [];
const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';

beforeEach(async () => {
  board = await createTestBoard();
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  await board.close();
  await cleanTmpDirs();
});

const code = (body: unknown): string => errorResponseSchema.parse(body).error.code;
const hashOf = (task: { title: string; body: string; labels: string[] }): string =>
  contentHash({ title: task.title, body: task.body, labels: task.labels });

async function createTask(over: object = {}): Promise<{
  id: string;
  title: string;
  body: string;
  labels: string[];
}> {
  const response = await board
    .post(`${API}/tasks`, {
      title: 'Ship it',
      body: 'See `src/git.ts`.\n',
      labels: ['ui'],
      ...over,
    })
    .expect(201);
  return response.body as { id: string; title: string; body: string; labels: string[] };
}

const report = (over: object = {}) => ({
  agent: 'claude-code',
  verdict: 'partly-outdated',
  summary: 'One path moved.',
  findings: [
    {
      id: 'f1',
      title: 'Moved',
      explanation: 'It moved.',
      evidence: [{ kind: 'file', ref: 'src/server/git/reader.ts' }],
    },
  ],
  recommendations: [
    {
      id: 'r1',
      findings: ['f1'],
      text: 'Update the path.',
      edit: { field: 'body', find: 'src/git.ts', replace: 'src/server/git/reader.ts' },
    },
    { id: 'r2', findings: [], text: 'Ask the owner.' },
  ],
  ...over,
});

async function begin(id: string): Promise<{ number: number; version: number }> {
  const response = await board
    .post(`${API}/tasks/${id}/checks`, { agent: 'claude-code', sessionId: SESSION })
    .expect(200);
  return response.body as { number: number; version: number };
}

async function versions(id: string) {
  const response = await board.get(`${API}/tasks/${id}/versions`).expect(200);
  return versionListSchema.parse(response.body);
}

const taskFile = (id: string): Promise<string> =>
  readFile(join(board.root, '.board', 'tasks', id, 'task.md'), 'utf8');

const historyFiles = async (id: string): Promise<string[]> =>
  (
    await readdir(join(board.root, '.board', 'tasks', id, 'history'), { recursive: true }).catch(
      () => [] as string[],
    )
  ).sort();

describe('versions', () => {
  it('lists the versions of a task and says it is at the latest', async () => {
    const task = await createTask();
    await board.patch(`${API}/tasks/${task.id}`, { title: 'Ship it now' }).expect(200);

    const list = await versions(task.id);

    expect(list.versions.map((v) => [v.number, v.source, v.changed])).toEqual([
      [1, 'create', []],
      [2, 'edit', ['title']],
    ]);
    expect(list.current).toEqual({
      hash: hashOf({ ...task, title: 'Ship it now' }),
      version: 2,
    });
  });

  it('reads one version with its snapshot', async () => {
    const task = await createTask();
    const response = await board.get(`${API}/tasks/${task.id}/versions/1`).expect(200);
    expect(taskVersionSchema.parse(response.body).snapshot).toEqual({
      title: 'Ship it',
      body: 'See `src/git.ts`.\n',
      labels: ['ui'],
    });
    const missing = await board.get(`${API}/tasks/${task.id}/versions/9`).expect(404);
    expect(code(missing.body)).toBe('VERSION_NOT_FOUND');
    await board.get(`${API}/tasks/T99/versions`).expect(404);
  });

  it('writes nothing on a GET, and shows content changed outside as no current version (INVARIANT)', async () => {
    const task = await createTask();
    await board.storage.updateTask(task.id, { body: 'edited elsewhere\n' });
    const files = await historyFiles(task.id);

    const list = await versions(task.id);

    expect(list.current.version).toBeNull();
    expect(list.versions).toHaveLength(1);
    expect(await historyFiles(task.id)).toEqual(files);
  });

  it('makes a baseline for a task an earlier board left without history', async () => {
    await board.storage.createTask({
      title: 'Legacy',
      status: 'todo',
      rank: 'a0',
      body: 'old\n',
      labels: [],
    });
    expect((await versions('T1')).versions).toEqual([]);
    await board.patch(`${API}/tasks/T1`, { body: 'new\n' }).expect(200);
    expect((await versions('T1')).versions.map((v) => [v.source, v.number])).toEqual([
      ['baseline', 1],
      ['edit', 2],
    ]);
  });

  it('makes no version of a move, of a status, or of a save without a change (INVARIANT)', async () => {
    const task = await createTask();
    await board.post(`${API}/tasks/${task.id}/move`, { status: 'done' }).expect(200);
    await board.patch(`${API}/tasks/${task.id}`, { status: 'todo', branch: 'feat/x' }).expect(200);
    await board
      .patch(`${API}/tasks/${task.id}`, { title: task.title, body: task.body })
      .expect(200);
    expect((await versions(task.id)).versions).toHaveLength(1);
  });

  it('announces a version, and a check, to the open pages', async () => {
    const task = await createTask();
    board.events.events.length = 0;
    await board.patch(`${API}/tasks/${task.id}`, { title: 'Again' }).expect(200);
    await begin(task.id);
    expect(board.events.events).toEqual([
      { type: 'version.created', taskId: task.id, number: 2 },
      expect.objectContaining({ type: 'task.updated' }),
      { type: 'check.updated', taskId: task.id, number: 1 },
    ]);
  });

  it('has no route that changes or removes the history (INVARIANT)', async () => {
    const task = await createTask();
    await begin(task.id);
    const history = routeList.filter((r) => /\/(versions|checks)/.test(r.path));
    expect(history.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /tasks/:id/checks',
      'GET /tasks/:id/checks/:n',
      'GET /tasks/:id/checks/:n/handoff',
      'GET /tasks/:id/versions',
      'GET /tasks/:id/versions/:n',
      'POST /tasks/:id/checks',
      'POST /tasks/:id/checks/:n/decisions',
      'POST /tasks/:id/checks/:n/end',
      'POST /tasks/:id/checks/:n/report',
      'POST /tasks/:id/versions/:n/restore',
    ]);
    for (const method of ['put', 'patch', 'del'] as const) {
      for (const path of ['versions/1', 'checks/1', 'checks/1/report']) {
        const response = await board[method](`${API}/tasks/${task.id}/${path}`, {});
        expect([405, 404]).toContain(response.status);
      }
    }
    await board.del(`${API}/tasks/${task.id}/versions`).expect(405);
    await board.del(`${API}/tasks/${task.id}/checks`).expect(405);
  });

  it('needs the token for every write, and reads without it', async () => {
    const task = await createTask();
    const bare = (path: string) => board.agent().post(`${API}${path}`).send({});
    for (const path of [
      `/tasks/${task.id}/versions/1/restore`,
      `/tasks/${task.id}/checks`,
      `/tasks/${task.id}/checks/1/report`,
      `/tasks/${task.id}/checks/1/end`,
      `/tasks/${task.id}/checks/1/decisions`,
    ]) {
      expect([path, (await bare(path)).status]).toEqual([path, 401]);
    }
    await board.agent().get(`${API}/tasks/${task.id}/versions`).expect(200);
    await board.agent().get(`${API}/tasks/${task.id}/checks`).expect(200);
  });
});

describe('PATCH with ifContentHash', () => {
  it('refuses a content that moved on with 409 TASK_CONTENT_CHANGED, and writes nothing (INVARIANT)', async () => {
    const task = await createTask();
    const stale = hashOf(task);
    await board.patch(`${API}/tasks/${task.id}`, { body: 'someone else\n' }).expect(200);
    const before = await taskFile(task.id);
    const files = await historyFiles(task.id);

    const response = await board
      .patch(`${API}/tasks/${task.id}`, { title: 'Mine', ifContentHash: stale })
      .expect(409);

    expect(code(response.body)).toBe('TASK_CONTENT_CHANGED');
    expect(errorResponseSchema.parse(response.body).error.details).toEqual({
      id: task.id,
      currentHash: hashOf({ ...task, body: 'someone else\n' }),
      latestVersion: 2,
    });
    expect(await taskFile(task.id)).toBe(before);
    expect(await historyFiles(task.id)).toEqual(files);
  });

  it('is last-write-wins without it, as for every agent (INVARIANT)', async () => {
    const task = await createTask();
    await board.patch(`${API}/tasks/${task.id}`, { body: 'someone else\n' }).expect(200);
    const response = await board.patch(`${API}/tasks/${task.id}`, { title: 'Mine' }).expect(200);
    expect(response.body).toMatchObject({ title: 'Mine', body: 'someone else\n' });
  });

  it('is checked for a PATCH of the status alone too', async () => {
    const task = await createTask();
    const response = await board
      .patch(`${API}/tasks/${task.id}`, { status: 'done', ifContentHash: 'f'.repeat(16) })
      .expect(409);
    expect(code(response.body)).toBe('TASK_CONTENT_CHANGED');
    expect((await board.get(`${API}/tasks/${task.id}`)).body).toMatchObject({ status: 'backlog' });
  });

  it('lets two saves on the same content make one version, and refuses the other', async () => {
    const task = await createTask();
    const hash = hashOf(task);
    const answers = await Promise.all(
      ['A', 'B', 'C'].map((title) =>
        board.patch(`${API}/tasks/${task.id}`, { title, ifContentHash: hash }),
      ),
    );
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409, 409]);
    expect((await versions(task.id)).versions).toHaveLength(2);
  });

  it('refuses a PATCH that carries nothing but the precondition, and a malformed hash', async () => {
    const task = await createTask();
    await board.patch(`${API}/tasks/${task.id}`, { ifContentHash: hashOf(task) }).expect(400);
    await board.patch(`${API}/tasks/${task.id}`, { title: 'x', ifContentHash: 'nope' }).expect(400);
  });
});

describe('restore', () => {
  it('writes the content of a version as a new version and keeps the status (INVARIANT)', async () => {
    const task = await createTask();
    const edited = (
      await board
        .patch(`${API}/tasks/${task.id}`, { title: 'Second', body: 'two\n', status: 'in-progress' })
        .expect(200)
    ).body as typeof task;

    const response = await board
      .post(`${API}/tasks/${task.id}/versions/1/restore`, { ifContentHash: hashOf(edited) })
      .expect(200);

    expect(response.body).toMatchObject({
      changed: true,
      task: { title: 'Ship it', body: task.body, status: 'in-progress' },
    });
    const list = await versions(task.id);
    expect(list.versions.map((v) => [v.source, v.restoredFrom])).toEqual([
      ['create', undefined],
      ['edit', undefined],
      ['restore', 1],
    ]);
  });

  it('needs the content the page saw, and says nothing was written when it is already that content', async () => {
    const task = await createTask();
    const same = await board
      .post(`${API}/tasks/${task.id}/versions/1/restore`, { ifContentHash: hashOf(task) })
      .expect(200);
    expect(same.body).toMatchObject({ changed: false });
    expect((await versions(task.id)).versions).toHaveLength(1);

    await board.post(`${API}/tasks/${task.id}/versions/1/restore`, {}).expect(400);
    const stale = await board
      .post(`${API}/tasks/${task.id}/versions/1/restore`, { ifContentHash: '0'.repeat(16) })
      .expect(409);
    expect(code(stale.body)).toBe('TASK_CONTENT_CHANGED');
    const missing = await board
      .post(`${API}/tasks/${task.id}/versions/7/restore`, { ifContentHash: hashOf(task) })
      .expect(404);
    expect(code(missing.body)).toBe('VERSION_NOT_FOUND');
  });
});

describe('the check', () => {
  it('begins on the version on disk and is listed with its state', async () => {
    const task = await createTask();
    expect(await begin(task.id)).toEqual({ number: 1, version: 1 });
    const list = await board.get(`${API}/tasks/${task.id}/checks`).expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({ number: 1, state: 'working', version: 1, agent: 'claude-code' }),
    ]);
    const one = checkSchema.parse((await board.get(`${API}/tasks/${task.id}/checks/1`)).body);
    expect(one).toMatchObject({ state: 'working', begin: { sessionId: SESSION } });
    expect((await board.get(`${API}/tasks/${task.id}/checks/5`)).status).toBe(404);
  });

  it('takes the report once and shows it as it was sent (INVARIANT)', async () => {
    const task = await createTask();
    const { number } = await begin(task.id);
    const sent = report({ uncertainty: 'Not sure about the build.' });

    const first = await board
      .post(`${API}/tasks/${task.id}/checks/${number}/report`, sent)
      .expect(200);
    expect(checkSchema.parse(first.body)).toMatchObject({ state: 'reported', report: sent });

    const second = await board
      .post(`${API}/tasks/${task.id}/checks/${number}/report`, report({ summary: 'Other.' }))
      .expect(409);
    expect(code(second.body)).toBe('CHECK_ALREADY_FINAL');
    const read = checkSchema.parse(
      (await board.get(`${API}/tasks/${task.id}/checks/${number}`)).body,
    );
    expect(read.report?.summary).toBe('One path moved.');
  });

  it('answers 422 INVALID_CHECK_REPORT for an edit whose find is not exactly once, and stays working', async () => {
    const task = await createTask({ body: 'a a' });
    const { number } = await begin(task.id);
    const bad = report({
      recommendations: [
        { id: 'r1', findings: [], text: 't', edit: { field: 'body', find: 'a', replace: 'b' } },
      ],
    });
    const response = await board
      .post(`${API}/tasks/${task.id}/checks/${number}/report`, bad)
      .expect(422);
    expect(code(response.body)).toBe('INVALID_CHECK_REPORT');
    expect(errorResponseSchema.parse(response.body).error.details).toMatchObject({
      problems: [expect.stringContaining('exactly once')],
    });
    expect(
      checkSchema.parse((await board.get(`${API}/tasks/${task.id}/checks/${number}`)).body).state,
    ).toBe('working');
  });

  it('refuses a malformed report as a bad request', async () => {
    const task = await createTask();
    const { number } = await begin(task.id);
    await board
      .post(`${API}/tasks/${task.id}/checks/${number}/report`, report({ verdict: 'great' }))
      .expect(400);
    await board
      .post(`${API}/tasks/${task.id}/checks/${number}/report`, report({ extra: true }))
      .expect(400);
  });

  it('takes one end, from the session that began it only', async () => {
    const task = await createTask();
    const { number } = await begin(task.id);
    const path = `${API}/tasks/${task.id}/checks/${number}/end`;
    const foreign = await board
      .post(path, { sessionId: 'b1b2c3d4-e5f6-4890-abcd-ef0123456789' })
      .expect(409);
    expect(code(foreign.body)).toBe('STALE_CHECK');
    const ended = await board
      .post(path, { sessionId: SESSION, exitCode: 1, endedAt: '2026-10-17T10:00:00.000Z' })
      .expect(200);
    expect(checkSchema.parse(ended.body)).toMatchObject({ state: 'failed' });
    const again = await board.post(path, { sessionId: SESSION }).expect(409);
    expect(code(again.body)).toBe('CHECK_ALREADY_FINAL');
  });

  it('changes no byte of task.md, and leaves the run of the task alone (INVARIANT)', async () => {
    const task = await createTask();
    await board.post(`${API}/tasks/${task.id}/ai-run`, {
      sessionId: 'c1b2c3d4-e5f6-4890-abcd-ef0123456789',
      mode: 'new',
    });
    const before = await taskFile(task.id);

    const { number } = await begin(task.id);
    await board.post(`${API}/tasks/${task.id}/checks/${number}/report`, report()).expect(200);
    await board.post(`${API}/tasks/${task.id}/checks/${number}/decisions`, {
      recommendation: 'r1',
      decision: 'accepted',
    });
    await board.post(`${API}/tasks/${task.id}/checks/${number}/end`, { sessionId: SESSION });

    expect(await taskFile(task.id)).toBe(before);
    expect((await board.get(`${API}/tasks/${task.id}`)).body).toMatchObject({
      aiRun: { state: 'working', runId: 1 },
    });
  });

  it('is not stopped by a run that works, and does not stop one (INVARIANT)', async () => {
    const task = await createTask();
    await board
      .post(`${API}/tasks/${task.id}/ai-run`, {
        sessionId: 'c1b2c3d4-e5f6-4890-abcd-ef0123456789',
        mode: 'new',
      })
      .expect(200);
    await begin(task.id);
    await begin(task.id);
    await board
      .post(`${API}/tasks/${task.id}/ai-run`, {
        sessionId: 'd1b2c3d4-e5f6-4890-abcd-ef0123456789',
        mode: 'new',
      })
      .expect(409);
  });

  it('serves a handoff with the pinned snapshot, not the live task, and no token', async () => {
    const task = await createTask({ body: 'Original text.\n' });
    const { number } = await begin(task.id);
    await board.patch(`${API}/tasks/${task.id}`, { body: 'Edited after the check began.\n' });

    const response = await board
      .get(`${API}/tasks/${task.id}/checks/${number}/handoff`)
      .expect(200);

    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.text).toContain('Original text.');
    expect(response.text).not.toContain('Edited after');
    expect(response.text).toContain(
      `POST ${board.origin}${API}/tasks/${task.id}/checks/${number}/report`,
    );
    expect(response.text).not.toContain(board.token);
  });

  it('asks for the language of the report when the task has one set', async () => {
    const task = await createTask();
    await board
      .patch(`${API}/tasks/${task.id}`, { workflow: { reportLanguage: 'ru' } })
      .expect(200);
    const { number } = await begin(task.id);
    const response = await board
      .get(`${API}/tasks/${task.id}/checks/${number}/handoff`)
      .expect(200);
    expect(response.text).toContain('in Russian');
  });
});

describe('decisions and applying a recommendation', () => {
  async function reported(task: { id: string }): Promise<number> {
    const { number } = await begin(task.id);
    await board.post(`${API}/tasks/${task.id}/checks/${number}/report`, report()).expect(200);
    return number;
  }
  const decide = (id: string, number: number, body: object) =>
    board.post(`${API}/tasks/${id}/checks/${number}/decisions`, body);

  it('takes a decision of a reported check and changes no task', async () => {
    const task = await createTask();
    const number = await reported(task);
    const before = await taskFile(task.id);
    const response = await decide(task.id, number, {
      recommendation: 'r1',
      decision: 'accepted',
      note: 'yes',
    }).expect(200);
    expect(response.body).toMatchObject({ number: 1, decision: 'accepted', note: 'yes' });
    expect(await taskFile(task.id)).toBe(before);
  });

  it('refuses a check without a report, an unknown check and an unknown recommendation, and writes nothing', async () => {
    const task = await createTask();
    const waiting = (await begin(task.id)).number;
    expect(
      code((await decide(task.id, waiting, { recommendation: 'r1', decision: 'accepted' })).body),
    ).toBe('CHECK_NOT_REPORTED');
    const number = await reported(task);
    expect(
      code((await decide(task.id, 9, { recommendation: 'r1', decision: 'accepted' })).body),
    ).toBe('CHECK_NOT_FOUND');
    expect(
      code((await decide(task.id, number, { recommendation: 'zz', decision: 'accepted' })).body),
    ).toBe('RECOMMENDATION_NOT_FOUND');
    const read = checkSchema.parse(
      (await board.get(`${API}/tasks/${task.id}/checks/${number}`)).body,
    );
    expect(read.decisions).toEqual([]);
  });

  it('applies an accepted recommendation of a current report, and records where it came from', async () => {
    const task = await createTask();
    const number = await reported(task);
    await decide(task.id, number, { recommendation: 'r1', decision: 'accepted' }).expect(200);
    const body = 'See `src/server/git/reader.ts`.\n';

    const response = await board
      .patch(`${API}/tasks/${task.id}`, {
        body,
        ifContentHash: hashOf(task),
        fromCheck: { check: number, recommendations: ['r1'], basis: 'report' },
      })
      .expect(200);

    expect(response.body).toMatchObject({ body });
    const list = await versions(task.id);
    expect(list.versions.at(-1)).toMatchObject({
      source: 'edit',
      fromCheck: { check: number, recommendations: ['r1'], basis: 'report' },
    });
  });

  it('answers 409 STALE_CHECK for a report of content that has moved on, and writes nothing (INVARIANT)', async () => {
    const task = await createTask();
    const number = await reported(task);
    await decide(task.id, number, { recommendation: 'r1', decision: 'accepted' }).expect(200);
    const moved = (await board.patch(`${API}/tasks/${task.id}`, { labels: ['ui', 'new'] }))
      .body as typeof task;
    const files = await historyFiles(task.id);
    const before = await taskFile(task.id);

    const response = await board
      .patch(`${API}/tasks/${task.id}`, {
        title: 'Changed',
        ifContentHash: hashOf(moved),
        fromCheck: { check: number, recommendations: ['r1'], basis: 'report' },
      })
      .expect(409);

    expect(code(response.body)).toBe('STALE_CHECK');
    expect(await taskFile(task.id)).toBe(before);
    expect(await historyFiles(task.id)).toEqual(files);
  });

  it('answers 409 STALE_CHECK for a recommendation that was rejected after it was accepted', async () => {
    const task = await createTask();
    const number = await reported(task);
    await decide(task.id, number, { recommendation: 'r1', decision: 'accepted' }).expect(200);
    await decide(task.id, number, { recommendation: 'r1', decision: 'rejected' }).expect(200);
    const response = await board
      .patch(`${API}/tasks/${task.id}`, {
        title: 'Changed',
        ifContentHash: hashOf(task),
        fromCheck: { check: number, recommendations: ['r1'], basis: 'report' },
      })
      .expect(409);
    expect(code(response.body)).toBe('STALE_CHECK');
  });

  it('answers 400 for a report applied without ifContentHash, but only after the three lookups', async () => {
    const task = await createTask();
    const number = await reported(task);
    const send = (check: number, recommendations: string[]) =>
      board.patch(`${API}/tasks/${task.id}`, {
        title: 'Changed',
        fromCheck: { check, recommendations, basis: 'report' },
      });
    expect(code((await send(9, ['r1']).expect(404)).body)).toBe('CHECK_NOT_FOUND');
    expect(code((await send(number, ['zz']).expect(404)).body)).toBe('RECOMMENDATION_NOT_FOUND');
    const missing = await send(number, ['r1']).expect(400);
    expect(code(missing.body)).toBe('INVALID_REQUEST');
  });

  it('takes a manual reconciliation on content that has changed, without a hash of the report', async () => {
    const task = await createTask();
    const number = await reported(task);
    await board.patch(`${API}/tasks/${task.id}`, { labels: ['ui', 'new'] }).expect(200);
    await board
      .patch(`${API}/tasks/${task.id}`, {
        title: 'By hand',
        fromCheck: { check: number, recommendations: ['r2'], basis: 'manual' },
      })
      .expect(200);
    expect((await versions(task.id)).versions.at(-1)?.fromCheck?.basis).toBe('manual');
  });
});

describe('POST /tasks/:id/run with kind check', () => {
  const RUNS = `${API}${routes['runs.stream'].path}`;

  async function runner(): Promise<SseClient<RunRequest>> {
    const client = await openStream(
      board.port,
      RUNS,
      { authorization: `Bearer ${board.token}` },
      (data) => runRequestSchema.parse(data),
    );
    open.push(client);
    return client;
  }

  it('hands a check to the runner and says so, and a run says nothing of kind', async () => {
    const task = await createTask();
    const waiting = await runner();
    const response = await board
      .post(`${API}/tasks/${task.id}/run`, { agent: 'claude-code', kind: 'check' })
      .expect(200);
    expect(response.body).toEqual({ taskId: task.id, agent: 'claude-code', kind: 'check' });
    await waiting.waitForEvents(1);
    expect(waiting.events).toEqual([
      { type: 'run.requested', taskId: task.id, agent: 'claude-code', kind: 'check' },
    ]);

    const plain = await runner();
    const work = await board
      .post(`${API}/tasks/${task.id}/run`, { agent: 'claude-code' })
      .expect(200);
    expect(work.body).toEqual({ taskId: task.id, agent: 'claude-code' });
    await plain.waitForEvents(1);
    expect(Object.keys(plain.events[0] ?? {})).not.toContain('kind');
  });

  it('is not refused while a run works, in any status of the task', async () => {
    const task = await createTask({ status: 'done' });
    await board
      .post(`${API}/tasks/${task.id}/ai-run`, {
        sessionId: 'c1b2c3d4-e5f6-4890-abcd-ef0123456789',
        mode: 'new',
      })
      .expect(200);
    await runner();
    await board
      .post(`${API}/tasks/${task.id}/run`, { agent: 'claude-code', kind: 'check' })
      .expect(200);
  });

  it('says NO_AGENT_RUNNER when none waits, takes no mode but new, and needs the task', async () => {
    const task = await createTask();
    const none = await board
      .post(`${API}/tasks/${task.id}/run`, { agent: 'claude-code', kind: 'check' })
      .expect(409);
    expect(code(none.body)).toBe('NO_AGENT_RUNNER');
    for (const mode of ['resume', 'restart']) {
      await board
        .post(`${API}/tasks/${task.id}/run`, { agent: 'claude-code', kind: 'check', mode })
        .expect(400);
    }
    await board.post(`${API}/tasks/T99/run`, { agent: 'claude-code', kind: 'check' }).expect(404);
  });

  it('changes nothing on the board: no run, no check, no version', async () => {
    const task = await createTask();
    await runner();
    const files = await historyFiles(task.id);
    const before = await taskFile(task.id);
    await board
      .post(`${API}/tasks/${task.id}/run`, { agent: 'claude-code', kind: 'check' })
      .expect(200);
    expect(await taskFile(task.id)).toBe(before);
    expect(await historyFiles(task.id)).toEqual(files);
  });
});
