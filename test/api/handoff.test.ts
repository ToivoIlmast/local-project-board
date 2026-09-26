import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  API_BASE_PATH as API,
  DEFAULT_AI_RULES,
  effectiveWorkflowSchema,
  errorResponseSchema,
  generateInstructions,
  renderWorkflowSteps,
  type EffectiveWorkflow,
  type WorkflowOverrides,
} from '../../src/contract/v1/index.js';
import { WORKFLOW_FLAGS, taskBranchName } from '../../src/core/index.js';
import { createTestBoard, STATUSES, type TestBoard } from '../support/httpBoard.js';
import { createMemoryStore, inMemoryStorage } from '../support/inMemoryStorage.js';
import { captureConsole, type CapturedConsole } from '../support/logs.js';
import { cleanTmpDirs } from '../support/tmp.js';

/**
 * The contract of `GET /tasks/:id/handoff` (T15): one text for one task — the task, how to work
 * on it under the settings that apply to it, and the instructions for the API. The settings are
 * the effective ones of T13/T14, read through the same services as `GET /tasks/:id/workflow`;
 * the handoff is generated on every request and stored nowhere.
 */

let board: TestBoard;
let logs: CapturedConsole;

beforeEach(() => {
  logs = captureConsole();
});

afterEach(async () => {
  logs.restore();
  await board.close();
  await cleanTmpDirs();
});

const none: WorkflowOverrides = { board: {}, statuses: {} };
const code = (body: unknown): string => errorResponseSchema.parse(body).error.code;

async function createTask(body: Record<string, unknown> = {}): Promise<string> {
  const response = await board
    .post(`${API}/tasks`, { title: 'Extract the git adapter', ...body })
    .expect(201);
  return (response.body as { id: string }).id;
}

const handoff = async (id: string): Promise<string> =>
  (await board.get(`${API}/tasks/${id}/handoff`).expect(200)).text;

const effective = async (id: string): Promise<EffectiveWorkflow> =>
  effectiveWorkflowSchema.parse((await board.get(`${API}/tasks/${id}/workflow`).expect(200)).body);

const replaceWorkflow = (overrides: WorkflowOverrides) =>
  board.put(`${API}/workflow`, overrides).expect(200);

const patchWorkflow = (id: string, workflow: unknown) =>
  board.patch(`${API}/tasks/${id}`, { workflow }).expect(200);

/** Only the numbered steps, so that a test says what it means and not what surrounds it. */
const stepsOf = (text: string): string[] =>
  text
    .split('## How to work on this task\n')[1]
    ?.split('\n---\n')[0]
    ?.split('\n')
    .filter((line) => /^\d+\. /.test(line)) ?? [];

const step = (text: string, start: string): string =>
  stepsOf(text).find((line) => line.replace(/^\d+\. /, '').startsWith(start)) ?? '';

/** Everything a handoff must leave alone: what is stored, byte for byte, and what was published. */
async function fingerprint(target: TestBoard): Promise<string> {
  const tasks = await target.storage.listTasks();
  const documents = await Promise.all(
    tasks.map(async (task) => [task.id, await target.storage.listDocuments(task.id)]),
  );
  const files: [string, string, number][] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push([path, await readFile(path, 'utf8'), (await stat(path)).mtimeMs]);
    }
  };
  await walk(target.root).catch(() => undefined);
  return JSON.stringify({
    tasks,
    documents,
    workflow: await target.storage.readWorkflow(),
    reports: await target.storage.listReports(),
    files: files.sort(),
    published: target.events.events,
  });
}

/** Both providers must give the API the same behaviour; only the disk has more to check. */
const providers: [string, () => Promise<TestBoard>][] = [
  ['the markdown provider', () => createTestBoard()],
  [
    'the in-memory provider',
    () => createTestBoard({ storage: inMemoryStorage(createMemoryStore()) }),
  ],
];

describe.each(providers)('GET /api/v1/tasks/:id/handoff with %s', (_name, create) => {
  beforeEach(async () => {
    board = await create();
  });

  describe('the answer', () => {
    it('is markdown that starts with the task, and needs no token', async () => {
      const id = await createTask({
        status: 'todo',
        body: '## Context\n\nThe parser is in HTTP.\n',
      });

      const response = await board.agent().get(`${API}/tasks/${id}/handoff`).expect(200);

      expect(response.headers['content-type']).toBe('text/markdown; charset=utf-8');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text.startsWith('# Task T1: Extract the git adapter\n')).toBe(true);
    });

    it('carries the task: id, title, status, labels, body and documents', async () => {
      const id = await createTask({
        status: 'todo',
        labels: ['refactor', 'git'],
        body: '## Context\n\nThe parser is in HTTP.\n',
      });
      await board.put(`${API}/tasks/${id}/documents/plan.md`, { content: '# Plan\n' }).expect(200);

      const text = await handoff(id);

      expect(text).toContain('# Task T1: Extract the git adapter');
      expect(text).toContain('- Status: `todo`');
      expect(text).toContain('- Labels: `refactor`, `git`');
      expect(text).toContain('## Context\n\nThe parser is in HTTP.');
      expect(text).toContain('`plan.md` (7 bytes)');
    });

    it('carries the general instructions of the board, live, and no token (INVARIANT)', async () => {
      const id = await createTask();

      const text = await handoff(id);

      expect(text).toContain(`Base URL: http://127.0.0.1:${board.port}${API}`);
      expect(text).toContain(STATUSES.join(', '));
      expect(text).toContain('test-board');
      expect(text).toContain('### GET /api/v1/tasks/:id/handoff');
      // The agent takes the token from the session route, as the instructions already say.
      expect(text).not.toContain(board.token);
      expect(text).toContain('Authorization: Bearer <session token>');
      expect(text).toContain(`GET http://127.0.0.1:${board.port}${API}/session`);
    });

    it('ends with the general instructions of this board, made without a token (INVARIANT)', async () => {
      const id = await createTask();

      const text = await handoff(id);

      const general = generateInstructions({
        baseUrl: `http://127.0.0.1:${board.port}`,
        board: { name: 'test-board', statuses: STATUSES, idPrefix: 'T' },
        rules: DEFAULT_AI_RULES,
      });
      expect(text.endsWith(general)).toBe(true);
    });

    it('never puts the token anywhere, not in the text and not in what the server logged (INVARIANT)', async () => {
      const id = await createTask({ body: 'Mentions nothing secret.' });

      const text = await handoff(id);

      expect(text).not.toContain(board.token);
      expect(logs.text()).not.toContain(board.token);
    });

    it('uses the ai.rules of the board it serves', async () => {
      await board.close();
      board = await createTestBoard({ rules: ['Ask before renaming a task.'] });
      const id = await createTask();

      const text = await handoff(id);

      expect(text).toContain('- Ask before renaming a task.');
    });
  });

  describe('the settings', () => {
    it('follows the defaults of a board with no overrides', async () => {
      const id = await createTask({ status: 'todo' });

      const text = await handoff(id);

      expect(step(text, 'Move the task to `in-progress`')).toContain('source: default');
      expect(step(text, 'You may change')).toContain('source: default');
      expect(step(text, 'Work in a branch')).toContain(
        `\`${taskBranchName(id, 'Extract the git adapter')}\``,
      );
      expect(step(text, 'Before you finish')).toContain('full pipeline');
      expect(step(text, 'Commit your work')).toBeTruthy();
      expect(step(text, 'Do not push')).toContain('source: default');
      expect(step(text, 'Write what you did')).toContain('report.md');
      expect(step(text, 'When you are done, leave')).toBeTruthy();
    });

    it('follows the overrides of the board', async () => {
      const id = await createTask({ status: 'todo' });
      await replaceWorkflow({
        board: { push: true, checkCommand: 'npm test', baseBranch: 'master', finishStatus: 'done' },
        statuses: {},
      });

      const text = await handoff(id);

      expect(step(text, 'Push your commits')).toContain('source: board');
      expect(step(text, 'Before you finish')).toContain('`npm test`');
      expect(step(text, 'Work in a branch')).toContain('based on `master`');
      expect(step(text, 'When you are done, move the task to `done`')).toContain('source: board');
    });

    it('follows the overrides of the column the task is in, and only that column', async () => {
      const inTodo = await createTask({ status: 'todo' });
      const inBacklog = await createTask({ status: 'backlog' });
      await replaceWorkflow({ board: {}, statuses: { todo: { commit: false } } });

      const todo = await handoff(inTodo);
      const backlog = await handoff(inBacklog);

      expect(step(todo, 'Do not commit')).toContain('source: column "todo"');
      expect(step(backlog, 'Commit your work')).toContain('source: default');
    });

    it('follows the overrides of the task itself', async () => {
      const id = await createTask({ status: 'todo' });
      await patchWorkflow(id, { push: true, report: false });

      const text = await handoff(id);

      expect(step(text, 'Push your commits')).toContain('source: this task');
      expect(step(text, 'Do not write a `report.md`')).toContain('source: this task');
    });

    it('lets the task win over the column, the column over the board, the board over the default (INVARIANT)', async () => {
      const id = await createTask({ status: 'todo' });
      const pushStep = async (): Promise<string> =>
        stepsOf(await handoff(id)).find((s) => /push/i.test(s)) ?? '';

      expect(await pushStep()).toMatch(/Do not push.*source: default/);
      await replaceWorkflow({ board: { push: true }, statuses: {} });
      expect(await pushStep()).toMatch(/Push your commits.*source: board/);
      await replaceWorkflow({ board: { push: true }, statuses: { todo: { push: false } } });
      expect(await pushStep()).toMatch(/Do not push.*source: column "todo"/);
      await patchWorkflow(id, { push: true });
      expect(await pushStep()).toMatch(/Push your commits.*source: this task/);
      await patchWorkflow(id, null);
      expect(await pushStep()).toMatch(/Do not push.*source: column "todo"/);
    });

    it('never turns `push: false` into permission to push, on any level (INVARIANT)', async () => {
      const id = await createTask({ status: 'todo' });
      const configurations: [WorkflowOverrides, unknown][] = [
        [none, undefined],
        [{ board: { push: false }, statuses: {} }, undefined],
        [{ board: { push: true }, statuses: { todo: { push: false } } }, undefined],
        [{ board: { push: true }, statuses: { todo: { push: true } } }, { push: false }],
      ];

      for (const [overrides, taskOverrides] of configurations) {
        await replaceWorkflow(overrides);
        await patchWorkflow(id, taskOverrides ?? null);

        const text = await handoff(id);

        expect(step(text, 'Do not push')).toBeTruthy();
        expect(text).not.toContain('Push your commits');
      }
    });

    it('says in so many words that nothing may be changed when editCode is off (INVARIANT)', async () => {
      const id = await createTask({ status: 'backlog' });
      await replaceWorkflow({
        board: { push: true, checkCommand: 'npm test' },
        statuses: { backlog: { editCode: false } },
      });

      const text = await handoff(id);

      expect(step(text, 'Do not change any file of the project')).toContain(
        'source: column "backlog"',
      );
      for (const start of [
        'Do not create a branch',
        'Do not run the checks',
        'Do not commit',
        'Do not push',
      ]) {
        expect(step(text, start)).toContain('inactive: editCode is off');
      }
      // Nothing that allows what was forbidden, even though push and checks are set on the board.
      for (const allowed of [
        'Push your commits',
        'Commit your work',
        'Work in a branch',
        'Before you finish, run',
      ]) {
        expect(text).not.toContain(allowed);
      }
      expect(stepsOf(text).join('\n')).not.toContain('npm test');
      // The way the result is delivered is left.
      expect(text).toContain(`PUT ${API}/tasks/${id}/documents/<name>.md`);
    });

    it.each(WORKFLOW_FLAGS)(
      'changes the steps when %s is switched, and only through the API (INVARIANT)',
      async (flag) => {
        const id = await createTask({ status: 'todo' });
        const defaults = await effective(id);
        const before = await handoff(id);

        await patchWorkflow(id, { [flag]: !defaults.values[flag] });
        const after = await handoff(id);

        expect(after).not.toBe(before);
        expect(stepsOf(after)).not.toEqual(stepsOf(before));
        // Whatever changed, it is inside the steps: the rest of the text is the same.
        expect(after.replace(/## How to work[\s\S]*?\n---\n/, '')).toBe(
          before.replace(/## How to work[\s\S]*?\n---\n/, ''),
        );
      },
    );

    it('is exactly what the effective settings of the API say (INVARIANT)', async () => {
      const id = await createTask({ status: 'todo' });
      const configurations: [WorkflowOverrides, unknown][] = [
        [none, null],
        [{ board: { push: true, checkCommand: 'npm test' }, statuses: {} }, null],
        [
          { board: { commit: false }, statuses: { todo: { commit: true, report: false } } },
          { push: true },
        ],
        [
          {
            board: { startStatus: null, finishStatus: 'done' },
            statuses: { todo: { editCode: false } },
          },
          null,
        ],
        [none, { editCode: false, branch: true, push: true }],
      ];

      for (const [overrides, taskOverrides] of configurations) {
        await replaceWorkflow(overrides);
        await patchWorkflow(id, taskOverrides);

        const text = await handoff(id);
        const expected = renderWorkflowSteps(await effective(id), {
          taskId: id,
          status: 'todo',
          branch: taskBranchName(id, 'Extract the git adapter'),
        });

        expect(text).toContain(expected);
      }
    });

    it('changes with a move to another column, because the settings depend on it', async () => {
      const id = await createTask({ status: 'todo' });
      await replaceWorkflow({ board: {}, statuses: { done: { editCode: false } } });
      expect(await handoff(id)).toContain('You may change the files of the project');

      await board.post(`${API}/tasks/${id}/move`, { status: 'done' }).expect(200);
      const text = await handoff(id);

      expect(text).toContain('- Status: `done`');
      expect(text).toContain('Do not change any file of the project');
      expect(text).toContain('source: column "done"');
    });

    it('works on the branch that the task has recorded, and on the one its title gives until then', async () => {
      const id = await createTask({ title: 'Ship the handoff' });
      expect(await handoff(id)).toContain('{"branch":"task/T1-ship-the-handoff"}');

      await board.patch(`${API}/tasks/${id}`, { branch: 'feat/handoff' }).expect(200);
      const text = await handoff(id);

      expect(text).toContain('- Branch: `feat/handoff`');
      expect(text).toContain('{"branch":"feat/handoff"}');
      expect(text).not.toContain('task/T1-ship-the-handoff');
    });

    it('sees an override that was replaced by the next PUT, not the one before (INVARIANT)', async () => {
      const id = await createTask({ status: 'todo' });
      await replaceWorkflow({ board: { push: true }, statuses: {} });
      expect(await handoff(id)).toContain('Push your commits');

      await replaceWorkflow(none);

      expect(await handoff(id)).not.toContain('Push your commits');
    });
  });

  describe('errors', () => {
    it('answers 404 TASK_NOT_FOUND for a task that is not there, as every other route does', async () => {
      const response = await board.get(`${API}/tasks/T99/handoff`).expect(404);

      expect(code(response.body)).toBe('TASK_NOT_FOUND');
      expect(response.headers['content-type']).toContain('application/json');
      expect(errorResponseSchema.parse(response.body).error.details).toEqual({ id: 'T99' });
    });

    it('answers 404 for a task that was deleted', async () => {
      const id = await createTask();
      await board.del(`${API}/tasks/${id}`).expect(200);

      await board.get(`${API}/tasks/${id}/handoff`).expect(404);
    });

    it.each(['banana', 't1', 'T0', '..%2FT1', 'T1%2F..'])(
      'answers 400 INVALID_REQUEST for the id %s, which no task can have',
      async (id) => {
        const response = await board.get(`${API}/tasks/${id}/handoff`).expect(400);

        expect(code(response.body)).toBe('INVALID_REQUEST');
      },
    );

    it('takes no other method: the handoff is read, never written', async () => {
      const id = await createTask();

      for (const send of [
        () => board.put(`${API}/tasks/${id}/handoff`, { content: 'x' }),
        () => board.post(`${API}/tasks/${id}/handoff`, {}),
        () => board.patch(`${API}/tasks/${id}/handoff`, {}),
        () => board.del(`${API}/tasks/${id}/handoff`),
      ]) {
        const response = await send().expect(405);
        expect(code(response.body)).toBe('METHOD_NOT_ALLOWED');
        expect(response.headers['allow']).toBe('GET');
      }
      expect(await handoff(id)).toContain('# Task T1');
    });
  });

  describe('it only reads', () => {
    it('changes nothing on the board and publishes nothing (INVARIANT)', async () => {
      const id = await createTask({ status: 'todo', labels: ['x'] });
      await board.put(`${API}/tasks/${id}/documents/plan.md`, { content: '# Plan\n' }).expect(200);
      await replaceWorkflow({ board: { push: true }, statuses: { todo: { editCode: false } } });
      await patchWorkflow(id, { report: false });
      board.events.events.length = 0;
      const before = await fingerprint(board);

      await handoff(id);
      await handoff(id);
      await board.get(`${API}/tasks/T99/handoff`).expect(404);

      expect(await fingerprint(board)).toBe(before);
      expect(board.events.events).toEqual([]);
    });

    it('is the same text for the same state of the board, every time (INVARIANT)', async () => {
      const id = await createTask({ status: 'todo' });
      await patchWorkflow(id, { push: true });

      const first = await handoff(id);

      expect(await handoff(id)).toBe(first);
      expect(await handoff(id)).toBe(first);
    });

    it('does not write the effective settings, nor itself, to the board', async () => {
      const id = await createTask({ status: 'todo' });
      await handoff(id);

      expect(await board.storage.readWorkflow()).toEqual(none);
      expect((await board.storage.getTask(id))?.workflow).toBeUndefined();
      expect(await board.storage.listDocuments(id)).toEqual([]);
    });
  });
});

describe('the handoff of a markdown board', () => {
  beforeEach(async () => {
    board = await createTestBoard();
  });

  it('sees a hand edit of .board/workflow.yaml on the next request, without a restart', async () => {
    const id = await createTask({ status: 'todo' });
    expect(await handoff(id)).toContain('Do not push');

    await writeFile(
      join(board.root, '.board', 'workflow.yaml'),
      'formatVersion: 1\nboard:\n  push: true\nstatuses:\n  todo:\n    commit: false\n',
      'utf8',
    );
    const text = await handoff(id);

    expect(text).toContain('Push your commits');
    expect(text).toContain('Do not commit');
  });

  it('sees the workflow that a task carries in its frontmatter', async () => {
    const id = await createTask({ status: 'todo' });
    const file = join(board.root, '.board', 'tasks', id, 'task.md');
    const source = await readFile(file, 'utf8');
    await writeFile(file, source.replace(/^---\n/, '---\nworkflow:\n  push: true\n'), 'utf8');

    expect(await handoff(id)).toContain('Push your commits');
  });

  it('runs on the defaults when workflow.yaml cannot be read, as the rest of the board does', async () => {
    const id = await createTask({ status: 'todo' });
    await writeFile(join(board.root, '.board', 'workflow.yaml'), 'formatVersion: [\n', 'utf8');

    const text = await handoff(id);

    expect(text).toContain('Do not push');
    expect(text).toContain('source: default');
  });
});
