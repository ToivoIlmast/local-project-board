import type { Storage } from '../../../src/core/ports.js';
import { createTaskLocks, type TaskLocks } from '../../../src/core/services/taskLocks.js';
import { createTaskService, type TaskService } from '../../../src/core/services/tasks.js';
import { recordingEventSink } from '../../support/events.js';
import { createMemoryStore, inMemoryStorage } from '../../support/inMemoryStorage.js';

const statuses = ['backlog', 'todo', 'in-progress', 'done'];
const FIRST = '2026-11-06T10:00:00.000Z';
const SECOND = '2026-11-06T11:00:00.000Z';

describe('doneAt (T96)', () => {
  let storage: Storage;
  let locks: TaskLocks;
  let tasks: TaskService;
  let clock: string;

  beforeEach(async () => {
    storage = inMemoryStorage(createMemoryStore());
    await storage.init();
    locks = createTaskLocks();
    clock = FIRST;
    tasks = createTaskService({
      storage,
      events: recordingEventSink(),
      statuses,
      locks,
      now: () => clock,
    });
  });

  const entries: [string, (id: string, status: string) => Promise<unknown>][] = [
    ['update', (id, status) => tasks.update(id, { status })],
    ['move', (id, status) => tasks.move(id, { status })],
  ];

  describe.each(entries)('through %s', (_name, change) => {
    it('is written when the task enters done', async () => {
      const task = await tasks.create({ title: 'A', status: 'in-progress' });
      await change(task.id, 'done');
      expect((await tasks.get(task.id)).doneAt).toBe(FIRST);
    });

    it.each(['backlog', 'todo', 'in-progress'])(
      'is cleared when the task leaves done for %s (INVARIANT)',
      async (to) => {
        const task = await tasks.create({ title: 'A', status: 'in-progress' });
        await change(task.id, 'done');
        await change(task.id, to);
        const after = await tasks.get(task.id);
        expect(after.status).toBe(to);
        expect(after.doneAt).toBeUndefined();
        expect(await storage.getTask(task.id)).not.toHaveProperty('doneAt');
      },
    );

    it('is a new one when the task is done again', async () => {
      const task = await tasks.create({ title: 'A', status: 'todo' });
      await change(task.id, 'done');
      await change(task.id, 'todo');
      clock = SECOND;
      await change(task.id, 'done');
      expect((await tasks.get(task.id)).doneAt).toBe(SECOND);
    });

    it('is left alone by a move between other statuses', async () => {
      const task = await tasks.create({ title: 'A', status: 'backlog' });
      await change(task.id, 'todo');
      expect((await tasks.get(task.id)).doneAt).toBeUndefined();
    });

    it('is left alone when a done task is put in done again', async () => {
      const task = await tasks.create({ title: 'A', status: 'todo' });
      await change(task.id, 'done');
      clock = SECOND;
      await change(task.id, 'done');
      expect((await tasks.get(task.id)).doneAt).toBe(FIRST);
    });

    it('is not written by a refused status', async () => {
      const task = await tasks.create({ title: 'A', status: 'todo' });
      await change(task.id, 'review').catch(() => undefined);
      expect((await tasks.get(task.id)).doneAt).toBeUndefined();
    });

    it('is written under the lock of the task', async () => {
      const task = await tasks.create({ title: 'A', status: 'todo' });
      let release!: () => void;
      const held = locks.run(task.id, () => new Promise<void>((resolve) => (release = resolve)));
      const pending = change(task.id, 'done');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await storage.getTask(task.id))?.status).toBe('todo');
      release();
      await held;
      await pending;
      expect((await tasks.get(task.id)).doneAt).toBe(FIRST);
    });
  });

  it('is not made up for a task that is done and has none (INVARIANT)', async () => {
    const legacy = await storage.createTask({
      title: 'Old',
      status: 'done',
      rank: 'a0',
      body: '',
      labels: [],
    });
    expect((await tasks.get(legacy.id)).doneAt).toBeUndefined();
    expect((await tasks.list()).find((task) => task.id === legacy.id)).not.toHaveProperty('doneAt');
    // Other changes of the task do not make one either, not even the same status again.
    await tasks.update(legacy.id, { title: 'Older', status: 'done' });
    await tasks.move(legacy.id, { status: 'done' });
    expect(await storage.getTask(legacy.id)).not.toHaveProperty('doneAt');
  });

  it('is kept by a change that is not a change of status', async () => {
    const task = await tasks.create({ title: 'A', status: 'todo' });
    await tasks.move(task.id, { status: 'done' });
    clock = SECOND;
    await tasks.update(task.id, { title: 'B', body: 'text\n' });
    expect((await tasks.get(task.id)).doneAt).toBe(FIRST);
  });
});
