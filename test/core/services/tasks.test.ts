import type { BoardError } from '../../../src/core/errors.js';
import type { Storage } from '../../../src/core/ports.js';
import { compareByRank } from '../../../src/core/rules/rank.js';
import { createTaskService, type TaskService } from '../../../src/core/services/tasks.js';
import { recordingEventSink, type RecordingEventSink } from '../../support/events.js';
import { createMemoryStore, inMemoryStorage } from '../../support/inMemoryStorage.js';

const statuses = ['backlog', 'todo', 'in-progress', 'done'];

describe('TaskService', () => {
  let storage: Storage;
  let events: RecordingEventSink;
  let tasks: TaskService;

  beforeEach(async () => {
    storage = inMemoryStorage(createMemoryStore());
    await storage.init();
    events = recordingEventSink();
    tasks = createTaskService({ storage, events, statuses });
  });

  async function code(action: Promise<unknown>): Promise<string> {
    return action.then(
      () => 'no error',
      (error: unknown) => (error as BoardError).code,
    );
  }

  describe('create', () => {
    it('fills in the defaults a caller may omit', async () => {
      const task = await tasks.create({ title: 'Write the services' });
      expect(task).toMatchObject({
        title: 'Write the services',
        status: 'backlog',
        body: '',
        labels: [],
      });
      expect(task.branch).toBeUndefined();
    });

    it('puts a new task at the end of its column', async () => {
      const first = await tasks.create({ title: 'One', status: 'todo' });
      const second = await tasks.create({ title: 'Two', status: 'todo' });
      expect(compareByRank(first, second)).toBeLessThan(0);
    });

    it('ranks the columns independently of each other', async () => {
      const todo = await tasks.create({ title: 'One', status: 'todo' });
      const done = await tasks.create({ title: 'Two', status: 'done' });
      expect(done.rank).toBe(todo.rank);
    });

    it('refuses a status that is not configured (INVARIANT)', async () => {
      expect(await code(tasks.create({ title: 'x', status: 'review' }))).toBe('UNKNOWN_STATUS');
      expect(await storage.listTasks()).toEqual([]);
      expect(events.events).toEqual([]);
    });

    it('announces the new task', async () => {
      const task = await tasks.create({ title: 'One' });
      expect(events.last()).toEqual({ type: 'task.created', task });
    });
  });

  describe('list', () => {
    it('orders by the configured status order, then by rank', async () => {
      const done = await tasks.create({ title: 'Done', status: 'done' });
      const todoA = await tasks.create({ title: 'A', status: 'todo' });
      const todoB = await tasks.create({ title: 'B', status: 'todo' });
      const backlog = await tasks.create({ title: 'Backlog', status: 'backlog' });
      expect((await tasks.list()).map((task) => task.id)).toEqual([
        backlog.id,
        todoA.id,
        todoB.id,
        done.id,
      ]);
    });
  });

  describe('get', () => {
    it('reads a task', async () => {
      const task = await tasks.create({ title: 'One' });
      expect(await tasks.get(task.id)).toEqual(task);
    });

    it('fails for a task that does not exist', async () => {
      expect(await code(tasks.get('T404'))).toBe('TASK_NOT_FOUND');
    });
  });

  describe('update', () => {
    it('changes only what it was given', async () => {
      const task = await tasks.create({ title: 'One', body: '# Body\n', labels: ['a'] });
      const updated = await tasks.update(task.id, { title: 'Renamed' });
      expect(updated).toMatchObject({ title: 'Renamed', body: '# Body\n', labels: ['a'] });
      expect(events.last()).toEqual({ type: 'task.updated', task: updated });
    });

    it('moves a task to the end of the new column when the status changes', async () => {
      const first = await tasks.create({ title: 'One', status: 'todo' });
      const second = await tasks.create({ title: 'Two', status: 'todo' });
      const moved = await tasks.update(first.id, { status: 'done' });
      const back = await tasks.update(moved.id, { status: 'todo' });
      expect(compareByRank(second, back)).toBeLessThan(0);
    });

    it('keeps the rank when the status does not change', async () => {
      const task = await tasks.create({ title: 'One', status: 'todo' });
      const updated = await tasks.update(task.id, { title: 'Renamed' });
      expect(updated.rank).toBe(task.rank);
    });

    it('refuses an unknown status and changes nothing', async () => {
      const task = await tasks.create({ title: 'One' });
      expect(await code(tasks.update(task.id, { status: 'review' }))).toBe('UNKNOWN_STATUS');
      expect(await tasks.get(task.id)).toEqual(task);
      expect(events.types()).toEqual(['task.created']);
    });

    it('fails for a task that does not exist', async () => {
      expect(await code(tasks.update('T404', { title: 'x' }))).toBe('TASK_NOT_FOUND');
      expect(events.events).toEqual([]);
    });
  });

  describe('move', () => {
    it('places a task between its new neighbours', async () => {
      const a = await tasks.create({ title: 'A', status: 'todo' });
      const b = await tasks.create({ title: 'B', status: 'todo' });
      const c = await tasks.create({ title: 'C', status: 'todo' });
      const moved = await tasks.move(c.id, { status: 'todo', after: a.id, before: b.id });
      expect((await tasks.list()).map((task) => task.id)).toEqual([a.id, moved.id, b.id]);
    });

    it('moves a task to another column', async () => {
      const task = await tasks.create({ title: 'A', status: 'todo' });
      const moved = await tasks.move(task.id, { status: 'done' });
      expect(moved.status).toBe('done');
      expect(events.last()).toEqual({ type: 'task.updated', task: moved });
    });

    it('refuses a neighbour from another column', async () => {
      const todo = await tasks.create({ title: 'A', status: 'todo' });
      const done = await tasks.create({ title: 'B', status: 'done' });
      expect(await code(tasks.move(todo.id, { status: 'todo', after: done.id }))).toBe(
        'NEIGHBOR_NOT_FOUND',
      );
    });

    it('refuses an unknown status', async () => {
      const task = await tasks.create({ title: 'A' });
      expect(await code(tasks.move(task.id, { status: 'review' }))).toBe('UNKNOWN_STATUS');
    });

    it('is idempotent when a task is moved where it already is', async () => {
      const a = await tasks.create({ title: 'A', status: 'todo' });
      const b = await tasks.create({ title: 'B', status: 'todo' });
      const first = await tasks.move(b.id, { status: 'todo', after: a.id });
      const again = await tasks.move(b.id, { status: 'todo', after: a.id });
      expect(again.rank).toBe(first.rank);
    });
  });

  describe('remove', () => {
    it('deletes the task and announces it', async () => {
      const task = await tasks.create({ title: 'One' });
      await tasks.remove(task.id);
      expect(await storage.getTask(task.id)).toBeNull();
      expect(events.last()).toEqual({ type: 'task.deleted', taskId: task.id });
    });

    it('fails for a task that does not exist, without announcing anything', async () => {
      expect(await code(tasks.remove('T404'))).toBe('TASK_NOT_FOUND');
      expect(events.events).toEqual([]);
    });
  });
});
