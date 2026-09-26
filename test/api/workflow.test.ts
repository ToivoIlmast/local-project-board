import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  API_BASE_PATH as API,
  effectiveWorkflowSchema,
  errorResponseSchema,
  taskSchema,
  workflowStateSchema,
  type WorkflowOverrides,
} from '../../src/contract/v1/index.js';
import { WORKFLOW_KEYS } from '../../src/core/model/index.js';
import { DEFAULT_WORKFLOW } from '../../src/core/rules/workflow.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { createMemoryStore, inMemoryStorage } from '../support/inMemoryStorage.js';
import { cleanTmpDirs } from '../support/tmp.js';

/**
 * The contract of the workflow routes (T14), on top of the model of T13 (ADR-0028):
 *
 * - `GET /workflow` — the overrides of the board and of its columns, next to the defaults;
 * - `PUT /workflow` — replaces the overrides of the board AND of the columns whole. Both
 *   sections are required, so a client that forgets one cannot wipe it without saying so;
 * - `GET /tasks/:id/workflow` — what one task runs with, computed on the request;
 * - `PATCH /tasks/:id {workflow}` — the task's own overrides: an object replaces them whole
 *   (as `labels` does), `null` removes them, leaving the key out leaves them alone.
 *
 * Only overrides are ever accepted or stored; the effective settings exist in answers only.
 */

let board: TestBoard;

afterEach(async () => {
  await board.close();
  await cleanTmpDirs();
});

const none: WorkflowOverrides = { board: {}, statuses: {} };
const code = (body: unknown): string => errorResponseSchema.parse(body).error.code;

async function createTask(body: Record<string, unknown> = {}): Promise<string> {
  const response = await board.post(`${API}/tasks`, { title: 'A task', ...body }).expect(201);
  return z.string().parse((response.body as { id: string }).id);
}

const readState = async () =>
  workflowStateSchema.parse((await board.get(`${API}/workflow`).expect(200)).body);
const readEffective = async (id: string) =>
  effectiveWorkflowSchema.parse((await board.get(`${API}/tasks/${id}/workflow`).expect(200)).body);
const readTask = async (id: string) =>
  taskSchema.parse((await board.get(`${API}/tasks/${id}`).expect(200)).body);

/** Both providers must give the API the same behaviour; only the disk has more to check. */
const providers: [string, () => Promise<TestBoard>][] = [
  ['the markdown provider', () => createTestBoard()],
  [
    'the in-memory provider',
    () => createTestBoard({ storage: inMemoryStorage(createMemoryStore()) }),
  ],
];

describe.each(providers)('the workflow routes on %s', (_name, open) => {
  beforeEach(async () => {
    board = await open();
  });

  describe('GET /workflow', () => {
    it('is exactly the built-in defaults on a board nobody has configured', async () => {
      const response = await board.get(`${API}/workflow`).expect(200);

      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(workflowStateSchema.parse(response.body)).toEqual({
        defaults: DEFAULT_WORKFLOW,
        board: {},
        statuses: {},
      });
    });

    it('answers with what the store holds, as overrides and nothing else', async () => {
      await board.storage.writeWorkflow({
        board: { push: true },
        statuses: { backlog: { editCode: false } },
      });

      const state = await readState();

      expect(state.board).toEqual({ push: true });
      expect(state.statuses).toEqual({ backlog: { editCode: false } });
      // The default is beside the override, never merged into it.
      expect(state.defaults.push).toBe(false);
    });

    it('needs no token and changes nothing', async () => {
      await board.agent().get(`${API}/workflow`).expect(200);
      expect(board.events.types()).toEqual([]);
      expect(await board.storage.readWorkflow()).toEqual(none);
    });
  });

  describe('PUT /workflow', () => {
    const overrides: WorkflowOverrides = {
      board: { push: true, startStatus: 'todo', finishStatus: null, checkCommand: 'npm test' },
      statuses: { backlog: { editCode: false }, done: { report: false, push: false } },
    };

    it('stores the overrides, answers with the state and gives it back on the next read', async () => {
      const response = await board.put(`${API}/workflow`, overrides).expect(200);

      const answer = workflowStateSchema.parse(response.body);
      expect(answer).toEqual({ defaults: DEFAULT_WORKFLOW, ...overrides });
      expect(await readState()).toEqual(answer);
      expect(await board.storage.readWorkflow()).toEqual(overrides);
    });

    it('is idempotent: the same request twice leaves the same board', async () => {
      const first = await board.put(`${API}/workflow`, overrides).expect(200);
      const second = await board.put(`${API}/workflow`, overrides).expect(200);

      expect(second.body).toEqual(first.body);
      expect(await board.storage.readWorkflow()).toEqual(overrides);
    });

    it('replaces the board and the columns whole: what is not sent is removed', async () => {
      await board.put(`${API}/workflow`, overrides).expect(200);

      await board
        .put(`${API}/workflow`, { board: { commit: false }, statuses: { todo: { push: true } } })
        .expect(200);

      expect(await board.storage.readWorkflow()).toEqual({
        board: { commit: false },
        statuses: { todo: { push: true } },
      });
    });

    it('clears everything when it is sent nothing to keep', async () => {
      await board.put(`${API}/workflow`, overrides).expect(200);
      await board.put(`${API}/workflow`, none).expect(200);

      expect(await readState()).toEqual({ defaults: DEFAULT_WORKFLOW, ...none });
    });

    it('keeps `null` as a value: it is different from a key that is not set', async () => {
      await board
        .put(`${API}/workflow`, {
          board: { startStatus: null, baseBranch: null },
          statuses: {},
        })
        .expect(200);

      expect((await readState()).board).toEqual({ startStatus: null, baseBranch: null });
    });

    it('does not touch a task, its overrides, its column or its timestamp', async () => {
      const id = await createTask({ status: 'todo' });
      await board.patch(`${API}/tasks/${id}`, { workflow: { push: true } }).expect(200);
      const before = await readTask(id);

      await board.put(`${API}/workflow`, overrides).expect(200);

      expect(await readTask(id)).toEqual(before);
    });

    it('publishes one workflow.updated event that says what the answer says', async () => {
      const response = await board.put(`${API}/workflow`, overrides).expect(200);

      expect(board.events.events).toEqual([{ type: 'workflow.updated', workflow: response.body }]);
    });

    describe('a status the board does not have', () => {
      it.each([
        ['a column', { board: {}, statuses: { review: { push: true } } }, 'statuses.review'],
        ['startStatus', { board: { startStatus: 'review' }, statuses: {} }, 'board.startStatus'],
        ['finishStatus', { board: { finishStatus: 'review' }, statuses: {} }, 'board.finishStatus'],
      ])(
        'is refused in %s with 422 UNKNOWN_STATUS, and nothing changes',
        async (_n, bad, where) => {
          await board.put(`${API}/workflow`, overrides).expect(200);
          board.events.events.length = 0;

          const response = await board.put(`${API}/workflow`, bad).expect(422);

          const { error } = errorResponseSchema.parse(response.body);
          expect(error.code).toBe('UNKNOWN_STATUS');
          expect(error.message).toContain(where);
          expect(error.details).toMatchObject({
            allowed: ['backlog', 'todo', 'in-progress', 'done'],
          });
          expect(await board.storage.readWorkflow()).toEqual(overrides);
          expect(board.events.types()).toEqual([]);
        },
      );

      it('is refused even when the rest of the request is right', async () => {
        await board
          .put(`${API}/workflow`, {
            board: { push: true },
            statuses: { todo: { push: true }, nope: { push: true } },
          })
          .expect(422);

        expect(await board.storage.readWorkflow()).toEqual(none);
      });

      it('is not confused by the name of an Object property', async () => {
        const send = (key: string) =>
          board
            .agent()
            .put(`${API}/workflow`)
            .set('Authorization', `Bearer ${board.token}`)
            .set('Content-Type', 'application/json')
            .send(`{"board":{},"statuses":{"${key}":{"push":true}}}`);

        for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
          expect([key, (await send(key)).status]).toEqual([key, 422]);
        }
        // `__proto__` is never a key of a parsed object: it is not stored, and nothing is polluted.
        await send('__proto__');
        expect(await board.storage.readWorkflow()).toEqual(none);
        expect(({} as Record<string, unknown>)['push']).toBeUndefined();
      });
    });

    describe('a request the contract does not describe', () => {
      const bad: [string, unknown][] = [
        ['no body at all', undefined],
        ['an array', []],
        ['a request without the columns (it would wipe them)', { board: { push: true } }],
        ['a request without the board (it would wipe it)', { statuses: {} }],
        ['an unknown section', { ...none, tasks: {} }],
        [
          'the answer of GET /workflow sent back, defaults and all',
          { defaults: DEFAULT_WORKFLOW, ...none },
        ],
        ['an unknown setting on the board', { board: { deploy: true }, statuses: {} }],
        ['an unknown setting in a column', { board: {}, statuses: { todo: { deploy: true } } }],
        [
          'a board-only setting in a column',
          { board: {}, statuses: { todo: { startStatus: null } } },
        ],
        [
          'a board-only setting in a column (checkCommand)',
          {
            board: {},
            statuses: { todo: { checkCommand: 'npm test' } },
          },
        ],
        ['a string where a boolean belongs', { board: { push: 'true' }, statuses: {} }],
        ['null where a boolean belongs', { board: { push: null }, statuses: {} }],
        ['a number for a status', { board: { startStatus: 3 }, statuses: {} }],
        ['an empty startStatus', { board: { startStatus: '' }, statuses: {} }],
        ['a blank checkCommand', { board: { checkCommand: '   ' }, statuses: {} }],
        ['a blank baseBranch', { board: { baseBranch: '' }, statuses: {} }],
        ['a column that is not an object', { board: {}, statuses: { todo: true } }],
        ['statuses as a list', { board: {}, statuses: ['todo'] }],
        ['an empty status name', { board: {}, statuses: { '': { push: true } } }],
        ['the effective settings of a task', { values: {}, sources: {}, inactive: [] }],
      ];

      it.each(bad)(
        'is refused with 400 INVALID_REQUEST, and nothing changes: %s',
        async (_n, body) => {
          await board.put(`${API}/workflow`, overrides).expect(200);
          board.events.events.length = 0;

          const response = await board.put(`${API}/workflow`, body).expect(400);

          expect(code(response.body)).toBe('INVALID_REQUEST');
          expect(await board.storage.readWorkflow()).toEqual(overrides);
          expect(board.events.types()).toEqual([]);
        },
      );

      it('is refused with 400 INVALID_JSON when the body is not JSON', async () => {
        const response = await board
          .agent()
          .put(`${API}/workflow`)
          .set('Authorization', `Bearer ${board.token}`)
          .set('Content-Type', 'application/json')
          .send('{"board":');
        expect(response.status).toBe(400);
        expect(code(response.body)).toBe('INVALID_JSON');
      });
    });

    describe('the session token and the origin', () => {
      it('is required: without it the answer is 401 and nothing is written', async () => {
        const response = await board.agent().put(`${API}/workflow`).send(overrides);

        expect(response.status).toBe(401);
        expect(code(response.body)).toBe('UNAUTHORIZED');
        expect(await board.storage.readWorkflow()).toEqual(none);
        expect(board.events.types()).toEqual([]);
      });

      it('is refused to a page of another origin, even with the right token', async () => {
        const response = await board
          .agent()
          .put(`${API}/workflow`)
          .set('Authorization', `Bearer ${board.token}`)
          .set('Origin', 'http://evil.com')
          .send(overrides);

        expect(response.status).toBe(403);
        expect(code(response.body)).toBe('FORBIDDEN_ORIGIN');
        expect(await board.storage.readWorkflow()).toEqual(none);
      });

      it('is refused to a request addressed to another host', async () => {
        const response = await board
          .agent()
          .put(`${API}/workflow`)
          .set('Authorization', `Bearer ${board.token}`)
          .set('Host', `evil.com:${board.port}`)
          .send(overrides);

        expect(response.status).toBe(403);
        expect(await board.storage.readWorkflow()).toEqual(none);
      });

      it('is accepted from the board’s own page', async () => {
        await board
          .agent()
          .put(`${API}/workflow`)
          .set('Authorization', `Bearer ${board.token}`)
          .set('Origin', board.origin)
          .send(overrides)
          .expect(200);
      });
    });

    it('takes no other method than GET and PUT', async () => {
      for (const send of [
        board.post(`${API}/workflow`, none),
        board.patch(`${API}/workflow`, none),
        board.del(`${API}/workflow`),
      ]) {
        const response = await send;
        expect(response.status).toBe(405);
        expect(response.headers['allow']).toBe('GET, PUT');
      }
    });
  });

  describe('GET /tasks/:id/workflow', () => {
    it('is the defaults, all from "default", for a task on an unconfigured board', async () => {
      const id = await createTask();

      const effective = await readEffective(id);

      expect(effective.values).toEqual(DEFAULT_WORKFLOW);
      expect(Object.keys(effective.sources).sort()).toEqual([...WORKFLOW_KEYS].sort());
      expect(new Set(Object.values(effective.sources))).toEqual(new Set(['default']));
      expect(effective.inactive).toEqual([]);
    });

    it('answers for a task that has no `workflow` without giving it one', async () => {
      const id = await createTask();
      const before = await board.get(`${API}/tasks/${id}`).expect(200);

      await readEffective(id);

      expect((before.body as { workflow?: unknown }).workflow).toBeUndefined();
      expect((await board.get(`${API}/tasks/${id}`).expect(200)).body).toEqual(before.body);
    });

    it('shows where every value comes from: default, board, column or task', async () => {
      const id = await createTask({ status: 'todo' });
      await board
        .put(`${API}/workflow`, {
          board: { push: true, commit: false, checkCommand: 'npm test' },
          statuses: { todo: { commit: true, checks: false }, done: { report: false } },
        })
        .expect(200);
      await board.patch(`${API}/tasks/${id}`, { workflow: { checks: true } }).expect(200);

      const { values, sources } = await readEffective(id);

      expect(values).toMatchObject({
        push: true,
        commit: true,
        checks: true,
        checkCommand: 'npm test',
        report: true,
      });
      expect(sources).toMatchObject({
        push: 'board',
        checkCommand: 'board',
        commit: 'status',
        checks: 'task',
        report: 'default',
        editCode: 'default',
        startStatus: 'default',
      });
    });

    it('changes when the settings of its column change', async () => {
      const id = await createTask({ status: 'todo' });
      expect((await readEffective(id)).values.push).toBe(false);

      await board.put(`${API}/workflow`, { board: {}, statuses: { todo: { push: true } } });

      const effective = await readEffective(id);
      expect(effective.values.push).toBe(true);
      expect(effective.sources.push).toBe('status');
    });

    it('changes when the task moves to another column (POST /move)', async () => {
      const id = await createTask({ status: 'todo' });
      await board
        .put(`${API}/workflow`, {
          board: {},
          statuses: { todo: { push: true }, done: { push: false, report: false } },
        })
        .expect(200);
      expect((await readEffective(id)).values).toMatchObject({ push: true, report: true });

      await board.post(`${API}/tasks/${id}/move`, { status: 'done' }).expect(200);

      const effective = await readEffective(id);
      expect(effective.values).toMatchObject({ push: false, report: false });
      expect(effective.sources).toMatchObject({ push: 'status', report: 'status' });
    });

    it('changes when the task changes its status (PATCH)', async () => {
      const id = await createTask({ status: 'todo' });
      await board
        .put(`${API}/workflow`, { board: {}, statuses: { backlog: { editCode: false } } })
        .expect(200);
      expect((await readEffective(id)).values.editCode).toBe(true);

      await board.patch(`${API}/tasks/${id}`, { status: 'backlog' }).expect(200);

      expect((await readEffective(id)).sources.editCode).toBe('status');
    });

    it('marks the settings that stop mattering, and does not repair their values', async () => {
      const id = await createTask({ status: 'backlog' });
      await board
        .put(`${API}/workflow`, {
          board: { push: true },
          statuses: { backlog: { editCode: false } },
        })
        .expect(200);

      const effective = await readEffective(id);

      expect(effective.inactive).toEqual(['branch', 'checks', 'commit', 'push']);
      expect(effective.values).toMatchObject({ editCode: false, push: true, branch: true });
    });

    it('does not write what it computes: the board’s and the task’s overrides stay as set', async () => {
      const id = await createTask({ status: 'todo' });
      await board.put(`${API}/workflow`, { board: { push: true }, statuses: {} }).expect(200);
      await board.patch(`${API}/tasks/${id}`, { workflow: { checks: false } }).expect(200);
      const task = await readTask(id);
      board.events.events.length = 0;

      await readEffective(id);

      expect(await board.storage.readWorkflow()).toEqual({ board: { push: true }, statuses: {} });
      expect(await readTask(id)).toEqual(task);
      expect(board.events.types()).toEqual([]);
    });

    it('is a 404 TASK_NOT_FOUND for a task that does not exist', async () => {
      const response = await board.get(`${API}/tasks/T99/workflow`).expect(404);
      expect(errorResponseSchema.parse(response.body).error).toMatchObject({
        code: 'TASK_NOT_FOUND',
        details: { id: 'T99' },
      });
    });

    it('is a 400 for something that cannot be a task id', async () => {
      const response = await board.get(`${API}/tasks/nope/workflow`).expect(400);
      expect(code(response.body)).toBe('INVALID_REQUEST');
    });

    it('is a read only: no other method is served', async () => {
      const id = await createTask();
      for (const send of [
        board.put(`${API}/tasks/${id}/workflow`, {}),
        board.post(`${API}/tasks/${id}/workflow`, {}),
        board.patch(`${API}/tasks/${id}/workflow`, {}),
        board.del(`${API}/tasks/${id}/workflow`),
      ]) {
        expect((await send).status).toBe(405);
      }
    });

    it('does not exist for the board as a whole: effective only means something for a task', async () => {
      for (const path of ['/workflow/effective', '/effective']) {
        const response = await board.get(`${API}${path}`);
        expect([path, response.status, code(response.body)]).toEqual([path, 404, 'NOT_FOUND']);
      }
    });
  });

  describe('POST /tasks with a workflow', () => {
    it('creates a task with its own overrides, and nothing else changes', async () => {
      const response = await board
        .post(`${API}/tasks`, {
          title: 'a',
          status: 'todo',
          workflow: { push: true, checks: false },
        })
        .expect(201);

      expect(taskSchema.parse(response.body).workflow).toEqual({ push: true, checks: false });
      expect((await readTask('T1')).workflow).toEqual({ push: true, checks: false });
      expect(await board.storage.readWorkflow()).toEqual(none);
      expect((await readEffective('T1')).sources).toMatchObject({ push: 'task', checks: 'task' });
    });

    it('creates a task without one, as before', async () => {
      const response = await board.post(`${API}/tasks`, { title: 'a' }).expect(201);
      expect(taskSchema.parse(response.body).workflow).toBeUndefined();
    });

    it.each([
      ['null (there is nothing to clear yet)', null],
      ['a board-only setting', { startStatus: 'todo' }],
      ['an unknown setting', { deploy: true }],
      ['effective values', { values: { push: true } }],
      ['a string for a boolean', { push: 'yes' }],
      ['a list', [{ push: true }]],
    ])('refuses %s with 400 and creates nothing', async (_n, workflow) => {
      const response = await board.post(`${API}/tasks`, { title: 'a', workflow }).expect(400);

      expect(code(response.body)).toBe('INVALID_REQUEST');
      expect(await board.storage.listTasks()).toEqual([]);
    });
  });

  describe('PATCH /tasks/:id with a workflow', () => {
    it('sets the task’s overrides and changes nothing else about the task', async () => {
      const id = await createTask({
        title: 'Keep me',
        body: '## Body\n',
        labels: ['x'],
        branch: 'feat/x',
        status: 'todo',
      });
      const before = await readTask(id);

      const response = await board.patch(`${API}/tasks/${id}`, { workflow: { push: true } });

      expect(response.status).toBe(200);
      const after = taskSchema.parse(response.body);
      const { workflow, updatedAt, ...rest } = after;
      const { updatedAt: _before, ...restBefore } = before;
      expect(workflow).toEqual({ push: true });
      expect(rest).toEqual(restBefore);
      expect(updatedAt >= _before).toBe(true);
    });

    it('is read back by the next request, and is what the effective settings use', async () => {
      const id = await createTask({ status: 'todo' });
      await board.patch(`${API}/tasks/${id}`, { workflow: { push: true } }).expect(200);

      expect((await readTask(id)).workflow).toEqual({ push: true });
      expect(await board.storage.getTask(id)).toMatchObject({ workflow: { push: true } });
      expect((await readEffective(id)).sources.push).toBe('task');
    });

    it('does not touch the overrides of the board or of the columns (INVARIANT)', async () => {
      const id = await createTask({ status: 'todo' });
      const overrides: WorkflowOverrides = {
        board: { checkCommand: 'npm test' },
        statuses: { todo: { commit: false } },
      };
      await board.put(`${API}/workflow`, overrides).expect(200);

      await board.patch(`${API}/tasks/${id}`, { workflow: { push: true } }).expect(200);
      await board.patch(`${API}/tasks/${id}`, { workflow: null }).expect(200);

      expect(await board.storage.readWorkflow()).toEqual(overrides);
    });

    it('is not touched by a change of the board, of the columns, or of another task', async () => {
      const id = await createTask({ status: 'todo' });
      const other = await createTask({ status: 'todo' });
      await board.patch(`${API}/tasks/${id}`, { workflow: { editCode: false, push: true } });

      await board.put(`${API}/workflow`, { board: { push: false }, statuses: {} }).expect(200);
      await board.patch(`${API}/tasks/${other}`, { workflow: null }).expect(200);
      await board.patch(`${API}/tasks/${id}`, { title: 'renamed' }).expect(200);

      expect((await readTask(id)).workflow).toEqual({ editCode: false, push: true });
    });

    it('replaces the task’s overrides whole, as `labels` does: what is not sent is removed', async () => {
      const id = await createTask();
      await board
        .patch(`${API}/tasks/${id}`, { workflow: { editCode: false, push: true } })
        .expect(200);

      await board.patch(`${API}/tasks/${id}`, { workflow: { push: false } }).expect(200);

      expect((await readTask(id)).workflow).toEqual({ push: false });
    });

    it('removes them all with `null`, and the task follows its column again', async () => {
      const id = await createTask({ status: 'todo', title: 'Keep me', labels: ['x'] });
      await board
        .put(`${API}/workflow`, { board: {}, statuses: { todo: { push: true } } })
        .expect(200);
      await board.patch(`${API}/tasks/${id}`, { workflow: { push: false } }).expect(200);
      expect((await readEffective(id)).values.push).toBe(false);

      const response = await board.patch(`${API}/tasks/${id}`, { workflow: null }).expect(200);

      const task = taskSchema.parse(response.body);
      expect(task).not.toHaveProperty('workflow');
      expect(task).toMatchObject({ title: 'Keep me', labels: ['x'], status: 'todo' });
      expect(await board.storage.getTask(id)).not.toHaveProperty('workflow');
      expect((await readEffective(id)).sources.push).toBe('status');
    });

    it('accepts `null` on a task that has no overrides, and leaves it as it was', async () => {
      const id = await createTask();
      await board.patch(`${API}/tasks/${id}`, { workflow: null }).expect(200);
      expect(await readTask(id)).not.toHaveProperty('workflow');
    });

    it('leaves the overrides alone when a patch does not mention them', async () => {
      const id = await createTask();
      await board.patch(`${API}/tasks/${id}`, { workflow: { push: true } }).expect(200);

      await board.patch(`${API}/tasks/${id}`, { title: 'renamed', labels: ['y'] }).expect(200);
      await board.post(`${API}/tasks/${id}/move`, { status: 'done' }).expect(200);

      expect((await readTask(id)).workflow).toEqual({ push: true });
    });

    it('takes the workflow together with other fields in one patch', async () => {
      const id = await createTask();

      await board
        .patch(`${API}/tasks/${id}`, { title: 'both', workflow: { report: false } })
        .expect(200);

      expect(await readTask(id)).toMatchObject({ title: 'both', workflow: { report: false } });
    });

    it('stores an empty object as an empty override: the effective settings do not move', async () => {
      const id = await createTask();
      const before = await readEffective(id);

      await board.patch(`${API}/tasks/${id}`, { workflow: {} }).expect(200);

      expect((await readTask(id)).workflow).toEqual({});
      expect(await readEffective(id)).toEqual(before);
    });

    it('publishes task.updated with the task as answered', async () => {
      const id = await createTask();
      board.events.events.length = 0;

      const response = await board.patch(`${API}/tasks/${id}`, { workflow: { push: true } });

      expect(board.events.events).toEqual([{ type: 'task.updated', task: response.body }]);
    });

    describe('a request the contract does not describe', () => {
      it.each([
        ['a board-only setting', { startStatus: 'todo' }],
        ['a board-only setting (checkCommand)', { checkCommand: 'npm test' }],
        ['an unknown setting', { deploy: true }],
        ['effective values sent back', { values: { push: true }, sources: {}, inactive: [] }],
        ['a whole effective answer', { editCode: true, sources: { editCode: 'default' } }],
        ['a string for a boolean', { push: 'true' }],
        ['null for a boolean', { push: null }],
        ['a list', [{ push: true }]],
        ['a string', 'push'],
        ['a boolean', true],
      ])('refuses %s with 400, and the task keeps its overrides', async (_n, workflow) => {
        const id = await createTask();
        await board.patch(`${API}/tasks/${id}`, { workflow: { editCode: false } }).expect(200);
        const before = await readTask(id);
        board.events.events.length = 0;

        const response = await board.patch(`${API}/tasks/${id}`, { workflow }).expect(400);

        expect(code(response.body)).toBe('INVALID_REQUEST');
        expect(await readTask(id)).toEqual(before);
        expect(board.events.types()).toEqual([]);
      });

      it('refuses a patch that sends nothing but an unknown field next to it', async () => {
        const id = await createTask();
        await board
          .patch(`${API}/tasks/${id}`, { workflow: { push: true }, effective: {} })
          .expect(400);
        expect((await readTask(id)).workflow).toBeUndefined();
      });

      it('answers 404 for a task that does not exist', async () => {
        const response = await board.patch(`${API}/tasks/T99`, { workflow: { push: true } });
        expect(response.status).toBe(404);
        expect(code(response.body)).toBe('TASK_NOT_FOUND');
      });
    });

    describe('the session token and the origin', () => {
      it('is required: without it the answer is 401 and the task is not changed', async () => {
        const id = await createTask();

        const response = await board
          .agent()
          .patch(`${API}/tasks/${id}`)
          .send({ workflow: { push: true } });

        expect(response.status).toBe(401);
        expect(code(response.body)).toBe('UNAUTHORIZED');
        expect((await readTask(id)).workflow).toBeUndefined();
      });

      it('is refused to a page of another origin, even with the right token', async () => {
        const id = await createTask();

        const response = await board
          .agent()
          .patch(`${API}/tasks/${id}`)
          .set('Authorization', `Bearer ${board.token}`)
          .set('Origin', 'http://evil.com')
          .send({ workflow: { push: true } });

        expect(response.status).toBe(403);
        expect(code(response.body)).toBe('FORBIDDEN_ORIGIN');
        expect((await readTask(id)).workflow).toBeUndefined();
      });
    });
  });
});

describe('the workflow on the markdown provider: the files', () => {
  const file = (): string => join(board.root, '.board', 'workflow.yaml');
  const taskFile = (id: string): string => join(board.root, '.board', 'tasks', id, 'task.md');

  beforeEach(async () => {
    board = await createTestBoard();
  });

  it('writes the overrides to .board/workflow.yaml, only those, and not the defaults', async () => {
    await board
      .put(`${API}/workflow`, {
        board: { push: true, checkCommand: 'npm test' },
        statuses: { backlog: { editCode: false } },
      })
      .expect(200);

    expect(await readFile(file(), 'utf8')).toBe(
      [
        'formatVersion: 1',
        'board:',
        '  push: true',
        '  checkCommand: npm test',
        'statuses:',
        '  backlog:',
        '    editCode: false',
        '',
      ].join('\n'),
    );
  });

  it('does not create the file for a read, an effective read or a task change', async () => {
    const id = await createTask();
    await board.get(`${API}/workflow`).expect(200);
    await board.get(`${API}/tasks/${id}/workflow`).expect(200);
    await board.patch(`${API}/tasks/${id}`, { workflow: { push: true } }).expect(200);

    await expect(stat(file())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes only what a task set into its frontmatter, and never what it runs with', async () => {
    const id = await createTask({ status: 'todo' });
    await board.put(`${API}/workflow`, { board: { push: true }, statuses: {} }).expect(200);
    await board.patch(`${API}/tasks/${id}`, { workflow: { checks: false } }).expect(200);
    await readEffective(id);

    const text = await readFile(taskFile(id), 'utf8');

    expect(text).toContain('workflow:\n  checks: false\n');
    for (const key of ['push', 'editCode', 'values', 'sources', 'inactive', 'defaults']) {
      expect(text).not.toContain(key);
    }
    expect(await readFile(file(), 'utf8')).not.toContain('checks');
  });

  it('removes the `workflow` key from the file for `null`', async () => {
    const id = await createTask();
    await board.patch(`${API}/tasks/${id}`, { workflow: { push: true } }).expect(200);
    await board.patch(`${API}/tasks/${id}`, { workflow: null }).expect(200);

    expect(await readFile(taskFile(id), 'utf8')).not.toContain('workflow');
  });

  it('reads a task written by hand without `workflow`, and a PATCH leaves that file without one', async () => {
    const id = await createTask();
    const written = [
      '---',
      `id: ${id}`,
      'title: Hand written',
      'status: todo',
      'rank: a0',
      'labels: []',
      'createdAt: 2026-09-21T09:00:00.000Z',
      'updatedAt: 2026-09-21T09:00:00.000Z',
      '---',
      'text',
      '',
    ].join('\n');
    await writeFile(taskFile(id), written);

    expect((await readEffective(id)).values).toEqual(DEFAULT_WORKFLOW);
    await board.patch(`${API}/tasks/${id}`, { title: 'Renamed', workflow: null }).expect(200);

    const after = await readFile(taskFile(id), 'utf8');
    expect(after).toContain('title: Renamed');
    expect(after).not.toContain('workflow');
  });

  it('shows a hand edit of workflow.yaml on the next request, without a restart', async () => {
    const id = await createTask({ status: 'todo' });
    await writeFile(
      file(),
      'formatVersion: 1\nboard:\n  push: true\nstatuses:\n  todo:\n    report: false\n',
    );

    expect((await readState()).board).toEqual({ push: true });
    expect((await readEffective(id)).values).toMatchObject({ push: true, report: false });
  });

  it('gives the defaults for a file that cannot be used, says so in /project, and a PUT repairs it', async () => {
    await writeFile(file(), 'formatVersion: 1\nboard:\n  push: maybe\n');
    const project = await board.get(`${API}/project`).expect(200);

    expect(await readState()).toEqual({ defaults: DEFAULT_WORKFLOW, ...none });
    expect((project.body as { readIssues: { file: string }[] }).readIssues).toMatchObject([
      { file: 'workflow.yaml' },
    ]);

    await board.put(`${API}/workflow`, { board: { push: true }, statuses: {} }).expect(200);

    expect((await readState()).board).toEqual({ push: true });
    const repaired = await board.get(`${API}/project`).expect(200);
    expect((repaired.body as { readIssues: unknown[] }).readIssues).toEqual([]);
  });

  it('reports a column that the configuration no longer has, and still answers', async () => {
    await writeFile(file(), 'formatVersion: 1\nstatuses:\n  review:\n    push: true\n');

    expect((await readState()).statuses).toEqual({ review: { push: true } });
  });
});

describe('a board with other columns', () => {
  it('has no default start status when the board has no `in-progress`', async () => {
    board = await createTestBoard({ statuses: ['todo', 'done'] });

    expect((await readState()).defaults.startStatus).toBeNull();
    const id = await createTask({ status: 'todo' });
    expect((await readEffective(id)).values.startStatus).toBeNull();
  });

  it('refuses a column of the default board that this board does not have', async () => {
    board = await createTestBoard({ statuses: ['todo', 'done'] });

    const response = await board
      .put(`${API}/workflow`, { board: {}, statuses: { backlog: { push: true } } })
      .expect(422);

    expect(code(response.body)).toBe('UNKNOWN_STATUS');
  });
});
