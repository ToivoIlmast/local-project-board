import type { BoardError } from '../../../src/core/errors.js';
import type { WorkflowOverrides } from '../../../src/core/model/index.js';
import type { Storage } from '../../../src/core/ports.js';
import { defaultWorkflow } from '../../../src/core/rules/workflow.js';
import { createTaskService, type TaskService } from '../../../src/core/services/tasks.js';
import {
  createWorkflowService,
  type WorkflowService,
} from '../../../src/core/services/workflow.js';
import { recordingEventSink, type RecordingEventSink } from '../../support/events.js';
import { createMemoryStore, inMemoryStorage } from '../../support/inMemoryStorage.js';

const statuses = ['backlog', 'todo', 'in-progress', 'done'];
const none: WorkflowOverrides = { board: {}, statuses: {} };

describe('WorkflowService', () => {
  let storage: Storage;
  let events: RecordingEventSink;
  let workflow: WorkflowService;
  let tasks: TaskService;

  beforeEach(async () => {
    storage = inMemoryStorage(createMemoryStore());
    await storage.init();
    events = recordingEventSink();
    workflow = createWorkflowService({ storage, events, statuses });
    tasks = createTaskService({ storage, events, statuses });
  });

  async function failure(action: Promise<unknown>): Promise<BoardError | undefined> {
    return action.then(
      () => undefined,
      (error: unknown) => error as BoardError,
    );
  }

  describe('read', () => {
    it('is exactly the built-in defaults on a board nobody has configured', async () => {
      expect(await workflow.read()).toEqual({ defaults: defaultWorkflow(statuses), ...none });
    });

    it('drops the default start status on a board that does not have it', async () => {
      const bare = createWorkflowService({ storage, events, statuses: ['todo', 'done'] });
      expect((await bare.read()).defaults.startStatus).toBeNull();
    });

    it('shows what is stored next to the defaults, and does not mix them (INVARIANT)', async () => {
      await workflow.replace({
        board: { push: true },
        statuses: { backlog: { editCode: false } },
      });

      const state = await workflow.read();

      expect(state.board).toEqual({ push: true });
      expect(state.statuses).toEqual({ backlog: { editCode: false } });
      expect(state.defaults.push).toBe(false);
      expect(state.defaults.editCode).toBe(true);
    });
  });

  describe('replace', () => {
    const overrides: WorkflowOverrides = {
      board: { push: true, startStatus: 'todo', finishStatus: null, checkCommand: 'npm test' },
      statuses: { backlog: { editCode: false }, done: { report: false } },
    };

    it('stores the overrides as given and answers with what a read would', async () => {
      const answer = await workflow.replace(overrides);

      expect(await storage.readWorkflow()).toEqual(overrides);
      expect(answer).toEqual(await workflow.read());
      expect(answer).toEqual({ defaults: defaultWorkflow(statuses), ...overrides });
    });

    it('replaces the board and the columns whole: what is not sent is gone', async () => {
      await workflow.replace(overrides);

      await workflow.replace({ board: { commit: false }, statuses: { todo: { push: true } } });

      expect(await storage.readWorkflow()).toEqual({
        board: { commit: false },
        statuses: { todo: { push: true } },
      });
    });

    it('clears everything when it is given nothing', async () => {
      await workflow.replace(overrides);
      await workflow.replace(none);
      expect(await storage.readWorkflow()).toEqual(none);
    });

    it('publishes one workflow.updated event with the state, after the write', async () => {
      const answer = await workflow.replace(overrides);

      expect(events.types()).toEqual(['workflow.updated']);
      expect(events.events[0]).toEqual({ type: 'workflow.updated', workflow: answer });
    });

    it('never touches a task, and never stores what a task runs with (INVARIANT)', async () => {
      const task = await tasks.create({ title: 'a', status: 'backlog' });
      await tasks.update(task.id, { workflow: { push: false } });
      events.events.length = 0;

      await workflow.replace(overrides);
      await workflow.forTask(task.id);

      expect(await storage.readWorkflow()).toEqual(overrides);
      expect((await storage.getTask(task.id))?.workflow).toEqual({ push: false });
    });

    it.each([
      ['a column', { board: {}, statuses: { review: { push: true } } }, 'statuses.review'],
      ['startStatus', { board: { startStatus: 'review' }, statuses: {} }, 'board.startStatus'],
      ['finishStatus', { board: { finishStatus: 'review' }, statuses: {} }, 'board.finishStatus'],
    ] satisfies [string, WorkflowOverrides, string][])(
      'refuses an unknown status in %s and changes nothing',
      async (_name, bad, where) => {
        await workflow.replace(overrides);
        events.events.length = 0;

        const error = await failure(workflow.replace(bad));

        expect(error).toMatchObject({ code: 'UNKNOWN_STATUS' });
        expect(error?.message).toContain(where);
        expect(error?.details).toMatchObject({ allowed: statuses });
        expect(await storage.readWorkflow()).toEqual(overrides);
        expect(events.types()).toEqual([]);
      },
    );

    it('names every unknown status at once, not only the first', async () => {
      const error = await failure(
        workflow.replace({
          board: { startStatus: 'a' },
          statuses: { b: { push: true }, done: { push: true } },
        }),
      );

      expect(error?.message).toContain('board.startStatus');
      expect(error?.message).toContain('statuses.b');
      expect(error?.message).not.toContain('statuses.done');
    });

    it('takes null for startStatus and finishStatus as a value', async () => {
      await workflow.replace({ board: { startStatus: null, finishStatus: null }, statuses: {} });
      expect((await storage.readWorkflow()).board).toEqual({
        startStatus: null,
        finishStatus: null,
      });
    });

    it('does not accept a status that only looks like a property of an object', async () => {
      for (const key of ['__proto__', 'constructor', 'toString']) {
        const bad = JSON.parse(
          `{"board":{},"statuses":{"${key}":{"push":true}}}`,
        ) as WorkflowOverrides;
        expect(await failure(workflow.replace(bad))).toMatchObject({ code: 'UNKNOWN_STATUS' });
      }
    });
  });

  describe('forTask', () => {
    it('is the defaults, each with the source "default", for a task without settings', async () => {
      const task = await tasks.create({ title: 'a' });

      const effective = await workflow.forTask(task.id);

      expect(effective.values).toEqual(defaultWorkflow(statuses));
      expect(new Set(Object.values(effective.sources))).toEqual(new Set(['default']));
      expect(effective.inactive).toEqual([]);
    });

    it('takes the board, then the column, then the task, each key from the last that set it', async () => {
      const task = await tasks.create({ title: 'a', status: 'todo' });
      await workflow.replace({
        board: { push: true, commit: false, checkCommand: 'npm test' },
        statuses: { todo: { commit: true, checks: false }, done: { report: false } },
      });
      await tasks.update(task.id, { workflow: { checks: true } });

      const { values, sources } = await workflow.forTask(task.id);

      expect(values).toMatchObject({
        push: true,
        commit: true,
        checks: true,
        checkCommand: 'npm test',
        report: true,
      });
      expect(sources).toMatchObject({
        push: 'board',
        commit: 'status',
        checks: 'task',
        checkCommand: 'board',
        report: 'default',
        startStatus: 'default',
      });
    });

    it('follows the task into another column (INVARIANT)', async () => {
      const task = await tasks.create({ title: 'a', status: 'todo' });
      await workflow.replace({
        board: {},
        statuses: { todo: { push: true }, done: { push: false, report: false } },
      });
      expect((await workflow.forTask(task.id)).values).toMatchObject({ push: true, report: true });

      await tasks.move(task.id, { status: 'done' });

      const { values, sources } = await workflow.forTask(task.id);
      expect(values).toMatchObject({ push: false, report: false });
      expect(sources).toMatchObject({ push: 'status', report: 'status' });
    });

    it('follows a change of the column settings, without the task being touched', async () => {
      const task = await tasks.create({ title: 'a', status: 'todo' });
      await workflow.replace({ board: {}, statuses: { todo: { editCode: false } } });
      const before = await storage.getTask(task.id);

      const { values, inactive } = await workflow.forTask(task.id);

      expect(values.editCode).toBe(false);
      expect(inactive).toEqual(['branch', 'checks', 'commit', 'push']);
      // The values of the inactive settings are left as configured, not repaired.
      expect(values).toMatchObject({ branch: true, checks: true, commit: true, push: false });
      expect(await storage.getTask(task.id)).toEqual(before);
    });

    it('reads a task that has no `workflow` as it always did, and does not add one', async () => {
      const task = await tasks.create({ title: 'a' });
      await workflow.forTask(task.id);
      expect((await storage.getTask(task.id))?.workflow).toBeUndefined();
    });

    it('is a 404 for a task that does not exist', async () => {
      expect(await failure(workflow.forTask('T99'))).toMatchObject({
        code: 'TASK_NOT_FOUND',
        details: { id: 'T99' },
      });
    });

    it('does not mistake a status that names an Object property for a configured column', async () => {
      const task = await tasks.create({ title: 'a', status: 'todo' });
      await storage.updateTask(task.id, { status: 'constructor' });
      await expect(workflow.forTask(task.id)).resolves.toMatchObject({ inactive: [] });
    });
  });
});
