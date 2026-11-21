import type { BoardError } from '../../../src/core/errors.js';
import type { Storage } from '../../../src/core/ports.js';
import { createTaskLocks } from '../../../src/core/services/taskLocks.js';
import { createTaskService, type TaskService } from '../../../src/core/services/tasks.js';
import { recordingEventSink, type RecordingEventSink } from '../../support/events.js';
import { createMemoryStore, inMemoryStorage } from '../../support/inMemoryStorage.js';

const statuses = ['backlog', 'todo', 'in-progress', 'done'];
const CLOCK = '2026-11-06T10:00:00.000Z';

const code = async (action: Promise<unknown>): Promise<string | undefined> =>
  action.then(
    () => undefined,
    (error: unknown) => (error as BoardError).code,
  );

describe('archive and restore (T3)', () => {
  let storage: Storage;
  let events: RecordingEventSink;
  let tasks: TaskService;

  beforeEach(async () => {
    storage = inMemoryStorage(createMemoryStore());
    await storage.init();
    events = recordingEventSink();
    tasks = createTaskService({
      storage,
      events,
      statuses,
      locks: createTaskLocks(),
      now: () => CLOCK,
    });
  });

  it.each(statuses)(
    'archives a task of %s and restores it exactly as it was, with no version (INVARIANT)',
    async (status) => {
      const created = await tasks.create({ title: 'A', status, body: 'Text', labels: ['x'] });
      await tasks.create({ title: 'Neighbour', status });
      const before = await tasks.get(created.id);
      const versions = await storage.listVersions(created.id);

      const archived = await tasks.archive(created.id);
      expect(archived.archived).toEqual({ at: CLOCK });
      expect({ ...archived, archived: undefined, updatedAt: '' }).toEqual({
        ...before,
        archived: undefined,
        updatedAt: '',
      });

      const restored = await tasks.restore(created.id);
      expect(restored).not.toHaveProperty('archived');
      expect({ ...restored, updatedAt: '' }).toEqual({ ...before, updatedAt: '' });
      expect(await storage.listVersions(created.id)).toEqual(versions);
    },
  );

  it('keeps doneAt of a done task, and its rank in the column', async () => {
    const task = await tasks.create({ title: 'A', status: 'in-progress' });
    await tasks.update(task.id, { status: 'done' });
    const done = await tasks.get(task.id);
    expect(done.doneAt).toBe(CLOCK);

    await tasks.archive(task.id);
    const restored = await tasks.restore(task.id);
    expect(restored.doneAt).toBe(CLOCK);
    expect(restored.rank).toBe(done.rank);
  });

  it('counts an archived task in its column, so a new task does not take its rank', async () => {
    const first = await tasks.create({ title: 'A', status: 'todo' });
    await tasks.archive(first.id);
    const second = await tasks.create({ title: 'B', status: 'todo' });
    expect(second.rank > first.rank).toBe(true);
  });

  it('publishes task.updated, and no version, for each', async () => {
    const task = await tasks.create({ title: 'A' });
    events.events.length = 0;
    const archived = await tasks.archive(task.id);
    const restored = await tasks.restore(task.id);
    expect(events.events).toEqual([
      { type: 'task.updated', task: archived },
      { type: 'task.updated', task: restored },
    ]);
  });

  it('refuses a second archive, and a restore of a task that is not archived (409)', async () => {
    const task = await tasks.create({ title: 'A' });
    expect(await code(tasks.restore(task.id))).toBe('TASK_NOT_ARCHIVED');
    await tasks.archive(task.id);
    expect(await code(tasks.archive(task.id))).toBe('TASK_ARCHIVED');
    expect(await code(tasks.archive('T404'))).toBe('TASK_NOT_FOUND');
    expect(await code(tasks.restore('T404'))).toBe('TASK_NOT_FOUND');
  });

  it('refuses a move and another status of an archived task, and writes nothing', async () => {
    const task = await tasks.create({ title: 'A', status: 'todo' });
    const archived = await tasks.archive(task.id);
    events.events.length = 0;

    expect(await code(tasks.move(task.id, { status: 'done' }))).toBe('TASK_ARCHIVED');
    expect(await code(tasks.move(task.id, { status: 'todo' }))).toBe('TASK_ARCHIVED');
    expect(await code(tasks.update(task.id, { status: 'done' }))).toBe('TASK_ARCHIVED');
    expect(await storage.getTask(task.id)).toEqual(archived);
    expect(events.events).toEqual([]);
  });

  it('lets the content, the same status and the delete of an archived task through', async () => {
    const task = await tasks.create({ title: 'A', status: 'todo' });
    await tasks.archive(task.id);
    const edited = await tasks.update(task.id, { title: 'B', status: 'todo' });
    expect(edited).toMatchObject({ title: 'B', status: 'todo', archived: { at: CLOCK } });
    await tasks.remove(task.id);
    expect(await code(tasks.get(task.id))).toBe('TASK_NOT_FOUND');
  });

  it('refuses to archive a task with a working run, and allows it when the run is over', async () => {
    const task = await tasks.create({ title: 'A' });
    await storage.updateTask(task.id, {
      aiRun: { agent: 'runner', state: 'working', runId: 1, startedAt: CLOCK },
    });
    expect(await code(tasks.archive(task.id))).toBe('AI_RUN_IN_PROGRESS');
    expect(await storage.getTask(task.id)).not.toHaveProperty('archived');

    await storage.updateTask(task.id, {
      aiRun: { agent: 'runner', state: 'finished', runId: 1, startedAt: CLOCK },
    });
    expect((await tasks.archive(task.id)).aiRun?.runId).toBe(1);
  });

  it('refuses to archive a task with a check that has not ended', async () => {
    const task = await tasks.create({ title: 'A' });
    const version = (await storage.listVersions(task.id))[0];
    await storage.beginCheck(task.id, {
      agent: 'claude-code',
      sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
      version: version?.number ?? 1,
      repo: { available: false },
    } as never);
    expect(await code(tasks.archive(task.id))).toBe('CHECK_IN_PROGRESS');
  });
});
