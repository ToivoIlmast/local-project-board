import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Storage } from '../../../src/core/ports.js';
import { createAiRunService, type AiRunService } from '../../../src/core/services/aiRunService.js';
import { markdownStorage } from '../../../src/server/storage/markdown/index.js';
import { cleanTmpDirs, tmpDir } from '../../support/tmp.js';

/**
 * The history of the runs of a task (T103, B1): every run stays, whatever begins after it.
 * Each test names the invariant it protects.
 */

const statuses = ['backlog', 'todo', 'in-progress', 'done'];
const S1 = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';
const S2 = 'a1b2c3d4-e5f6-4890-abcd-ef0123456790';

let root: string;
let storage: Storage;
let service: AiRunService;

async function open(): Promise<void> {
  storage = markdownStorage({ root });
  await storage.init();
  service = createAiRunService({ storage, statuses });
}

beforeEach(async () => {
  root = await tmpDir();
  await open();
});

afterEach(cleanTmpDirs);

async function createTask(): Promise<string> {
  const task = await storage.createTask({
    title: 'Do something',
    status: 'in-progress',
    rank: 'a0',
    body: '',
    labels: [],
  });
  return task.id;
}

const history = async (id: string) => (await storage.getTask(id))?.aiRunHistory;

describe('aiRun history', () => {
  it('keeps the comment of a run in that run only, and in its history record (INVARIANT)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: S1, mode: 'new', comment: 'mind the tests' });
    expect((await storage.getTask(id))?.aiRun?.comment).toBe('mind the tests');
    await service.end(id, 1, { exitCode: 0, sessionId: S1 });

    await service.begin(id, { sessionId: S2, mode: 'new' });
    const task = await storage.getTask(id);
    expect(task?.aiRun?.comment).toBeUndefined();
    expect(task?.aiRunHistory?.map((run) => run.comment)).toEqual(['mind the tests', undefined]);
  });

  it('keeps the outcome of run 1 after run 2 begins (INVARIANT)', async () => {
    const id = await createTask();
    await service.begin(id, {
      sessionId: S1,
      mode: 'new',
      model: 'm1',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    await service.end(id, 1, { exitCode: 2, endedAt: '2026-01-01T00:05:00.000Z' });
    await service.begin(id, { sessionId: S1, mode: 'resume', model: 'm2' });

    const runs = await history(id);
    expect(runs?.map((run) => run.runId)).toEqual([1, 2]);
    expect(runs?.[0]).toMatchObject({
      runId: 1,
      sessionId: S1,
      mode: 'new',
      model: 'm1',
      state: 'failed',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:05:00.000Z',
      failure: { kind: 'exit', exitCode: 2 },
    });
    expect(runs?.[1]).toMatchObject({ runId: 2, mode: 'resume', state: 'working' });
    // The current run is still what aiRun says.
    expect((await storage.getTask(id))?.aiRun?.runId).toBe(2);
  });

  it('keeps checks, commit and finishedAt of a reported run (INVARIANT)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: S1, mode: 'new' });
    await service.report(id, 1, {
      agent: 'claude-code',
      state: 'finished',
      checks: 'passed',
      commit: 'abcdef1',
      finishedAt: '2026-01-01T00:04:00.000Z',
    });
    await service.begin(id, { sessionId: S2, mode: 'new' });

    expect((await history(id))?.[0]).toMatchObject({
      state: 'finished',
      checks: 'passed',
      commit: 'abcdef1',
      finishedAt: '2026-01-01T00:04:00.000Z',
    });
  });

  it('operations on run N do not change the record of run N-1 (INVARIANT)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: S1, mode: 'new' });
    await service.end(id, 1, { exitCode: 1 });
    await service.begin(id, { sessionId: S2, mode: 'new' });
    const first = structuredClone((await history(id))?.[0]);

    await service.report(id, 2, { agent: 'claude-code', state: 'finished', checks: 'passed' });
    await service.end(id, 2, { exitCode: 0, endedAt: '2026-01-02T00:00:00.000Z' });
    await service.begin(id, { sessionId: S2, mode: 'restart' });
    await service.abandon(id, 3, { sessionId: S2, message: 'gone' });

    const runs = await history(id);
    expect(runs?.[0]).toEqual(first);
    expect(runs?.map((run) => run.runId)).toEqual([1, 2, 3]);
    expect(runs?.[1]).toMatchObject({ state: 'finished', checks: 'passed' });
    expect(runs?.[2]).toMatchObject({ state: 'failed', failure: { kind: 'lost' } });
  });

  it('an end delivered after a restart of the board lands in its own run (INVARIANT)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: S1, mode: 'new' });
    await service.end(id, 1, { exitCode: 1 });
    await service.begin(id, { sessionId: S1, mode: 'resume' });

    // The board restarts: a new storage and service over the same files.
    await open();
    await service.end(id, 2, { exitCode: 3, endedAt: '2026-01-03T00:00:00.000Z' });

    const runs = await history(id);
    expect(runs?.[0]).toMatchObject({ runId: 1, failure: { exitCode: 1 } });
    expect(runs?.[1]).toMatchObject({
      runId: 2,
      state: 'failed',
      endedAt: '2026-01-03T00:00:00.000Z',
      failure: { kind: 'exit', exitCode: 3 },
    });
  });

  it('a late end of an earlier run is refused and changes no record (INVARIANT)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: S1, mode: 'new' });
    await service.end(id, 1, { exitCode: 1 });
    await service.begin(id, { sessionId: S1, mode: 'resume' });
    const before = structuredClone(await history(id));

    await expect(service.end(id, 1, { exitCode: 9 })).rejects.toMatchObject({
      code: 'STALE_AI_RUN',
    });
    expect(await history(id)).toEqual(before);
  });

  it('the history holds no token (INVARIANT)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: S1, mode: 'new' });
    await service.end(id, 1, { launchError: 'spawn failed' });

    const text = await readFile(join(root, '.board', 'tasks', id, 'task.md'), 'utf8');
    expect(text).toContain('aiRunHistory');
    expect(text.toLowerCase()).not.toContain('token');
    expect(JSON.stringify(await history(id)).toLowerCase()).not.toContain('token');
  });
});
