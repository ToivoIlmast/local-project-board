import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configure, screen, waitFor, within } from '@testing-library/react';
import { parse } from 'yaml';
import { WORKFLOW_LABELS } from '../../../src/web/features/settings/index';
import { cleanTmpDirs, tmpDir } from '../../support/tmp';
import { renderAgainstRealBoard, type RealBoard } from '../support/realBoard';

const SLOW_MS = 30_000;

configure({ asyncUtilTimeout: 10_000 });

let board: RealBoard | undefined;

afterEach(async () => {
  board?.unmount();
  await board?.server.close().catch(() => undefined);
  board = undefined;
  await cleanTmpDirs();
});

const details = () => screen.getByRole('complementary', { name: 'Task T1' });
const ai = () => within(details()).getByRole('region', { name: 'AI' });
const field = (label: string) => within(ai()).getByLabelText(label);
const push = () => field(WORKFLOW_LABELS.push.label);

/** A board with one task in "todo" and the page open on it. */
async function withTask(root?: string): Promise<RealBoard> {
  const started = await renderAgainstRealBoard(root === undefined ? {} : { root });
  board = started;
  await started.server.post('/api/v1/tasks', { title: 'Ship it', status: 'todo' }).expect(201);
  await started.user.click(await screen.findByRole('button', { name: 'Ship it' }));
  await screen.findByRole('complementary', { name: 'Task T1' });
  // The panel reads the documents of the task as it opens; let that finish before the test acts.
  await within(details()).findByText('No documents');
  return started;
}

const taskFile = async (root: string): Promise<string> =>
  readFile(join(root, '.board', 'tasks', 'T1', 'task.md'), 'utf8');

const frontmatter = async (root: string): Promise<Record<string, unknown>> => {
  const text = await taskFile(root);
  return parse(text.split('---\n')[1] ?? '') as Record<string, unknown>;
};

const workflowFile = async (root: string): Promise<string | null> =>
  readFile(join(root, '.board', 'workflow.yaml'), 'utf8').catch(() => null);

const effective = async (server: RealBoard['server']) =>
  (await server.get('/api/v1/tasks/T1/workflow').expect(200)).body as {
    values: Record<string, unknown>;
    sources: Record<string, string>;
    inactive: string[];
  };

describe('the AI block of a task on a real board', () => {
  it(
    'stores only the overrides of the task in its file, and never what is in effect',
    async () => {
      const root = await tmpDir();
      const { user, server } = await withTask(root);
      await server
        .put('/api/v1/workflow', {
          board: { push: true, checkCommand: 'npm test' },
          statuses: { todo: { report: false } },
        })
        .expect(200);
      const boardFileBefore = await workflowFile(root);
      await user.click(within(ai()).getByRole('button', { name: 'Customize for this task' }));
      await waitFor(() => expect(push()).toHaveAccessibleDescription(/from the board/));

      await user.selectOptions(field(WORKFLOW_LABELS.commit.label), 'Off');
      await user.click(within(ai()).getByRole('button', { name: 'Save' }));
      await within(ai()).findByText('Saved.');

      // The file has one override. Not the pushes, the reports or the command that are in effect.
      expect((await frontmatter(root)).workflow).toEqual({ commit: false });
      expect(await taskFile(root)).not.toMatch(/checkCommand|npm test|sources|inactive|values/);
      // The board and the column are byte for byte what they were.
      expect(await workflowFile(root)).toBe(boardFileBefore);
      // And the board computes the task from all three levels.
      const computed = await effective(server);
      expect(computed.values).toMatchObject({ commit: false, push: true, report: false });
      expect(computed.sources).toMatchObject({
        commit: 'task',
        push: 'board',
        report: 'status',
        checks: 'default',
      });
    },
    SLOW_MS,
  );

  it(
    'takes the workflow out of the file altogether when the last setting goes, and the task inherits again',
    async () => {
      const root = await tmpDir();
      const { user, server } = await withTask(root);
      await server
        .put('/api/v1/workflow', { board: {}, statuses: { todo: { push: true } } })
        .expect(200);
      await server.patch('/api/v1/tasks/T1', { workflow: { push: false } }).expect(200);
      await waitFor(() => expect(push()).toHaveDisplayValue('Off'));
      expect((await frontmatter(root)).workflow).toEqual({ push: false });
      expect((await effective(server)).sources.push).toBe('task');

      // What "inherit" would give is worked out on the page for its label; the board must agree.
      const inherit = within(push()).getByRole('option', { name: /^Inherit/ });
      expect(inherit).toHaveTextContent('Inherit (now on, from the column todo)');

      await user.selectOptions(push(), 'inherit');
      await user.click(within(ai()).getByRole('button', { name: 'Save' }));
      await within(ai()).findByText(/Uses the settings of column todo/);

      expect(await frontmatter(root)).not.toHaveProperty('workflow');
      expect(await taskFile(root)).not.toMatch(/workflow/);
      const computed = await effective(server);
      expect(computed.values.push).toBe(true);
      expect(computed.sources.push).toBe('status');
    },
    SLOW_MS,
  );

  it(
    'resets with one action, and the column and board settings are untouched',
    async () => {
      const root = await tmpDir();
      const { user, server } = await withTask(root);
      await server
        .put('/api/v1/workflow', { board: { checks: false }, statuses: { todo: { push: true } } })
        .expect(200);
      await server
        .patch('/api/v1/tasks/T1', { workflow: { push: false, checks: true, report: false } })
        .expect(200);
      await waitFor(() => expect(push()).toHaveDisplayValue('Off'));
      const boardFileBefore = await workflowFile(root);

      await user.click(
        within(ai()).getByRole('button', { name: 'Reset to the settings of column todo' }),
      );
      await within(ai()).findByText(/Uses the settings of column todo/);

      expect(await taskFile(root)).not.toMatch(/workflow/);
      expect(await workflowFile(root)).toBe(boardFileBefore);
      const computed = await effective(server);
      expect(computed.values).toMatchObject({ push: true, checks: false, report: true });
      expect(computed.sources).toMatchObject({
        push: 'status',
        checks: 'board',
        report: 'default',
      });
    },
    SLOW_MS,
  );

  it(
    'shows for every setting the same value and source as the board computes (INVARIANT)',
    async () => {
      const { server } = await withTask();
      await server
        .put('/api/v1/workflow', {
          board: { push: true, editCode: false },
          statuses: { todo: { report: false, editCode: true } },
        })
        .expect(200);
      await server.patch('/api/v1/tasks/T1', { workflow: { checks: false } }).expect(200);
      await waitFor(() => expect(push()).toHaveAccessibleDescription(/In effect/));

      const computed = await effective(server);
      const sourceText = (source: string, status = 'todo'): string =>
        ({
          default: 'the default',
          board: 'the board',
          status: `the column ${status}`,
          task: 'this task',
        })[source] ?? source;
      for (const key of ['editCode', 'branch', 'checks', 'commit', 'push', 'report'] as const) {
        const now = computed.values[key] === true ? 'on' : 'off';
        expect(field(WORKFLOW_LABELS[key].label)).toHaveAccessibleDescription(
          new RegExp(`^In effect: ${now}, from ${sourceText(computed.sources[key] ?? '')}\\.`),
        );
      }
      // The ones that do not apply without code, as the board lists them.
      for (const key of computed.inactive) {
        expect(field(WORKFLOW_LABELS[key as 'push'].label)).toHaveAccessibleDescription(
          /Not used while/,
        );
      }
    },
    SLOW_MS,
  );
});

describe('sending a task to an agent from a real board', () => {
  it(
    'copies the very text the handoff route answers with, and no token',
    async () => {
      const { user, server } = await withTask();

      await user.click(within(details()).getByRole('button', { name: 'Send to AI' }));
      await user.click(screen.getByRole('button', { name: 'Copy handoff' }));
      await within(details()).findByText('Handoff copied to the clipboard.');

      const served = (await server.get('/api/v1/tasks/T1/handoff').expect(200)).text;
      expect(await navigator.clipboard.readText()).toBe(served);
      expect(served).toContain('# Task T1: Ship it');
      expect(served).not.toContain(server.token);
    },
    SLOW_MS,
  );

  it(
    'copies a handoff that has the change of the task in it, and loses it again on reset',
    async () => {
      const { user, server } = await withTask();
      const copy = async (): Promise<string> => {
        await user.click(within(details()).getByRole('button', { name: 'Send to AI' }));
        await user.click(screen.getByRole('button', { name: 'Copy handoff' }));
        await within(details()).findByText('Handoff copied to the clipboard.');
        return navigator.clipboard.readText();
      };
      expect(await copy()).toContain(
        'Do not push: nothing leaves this machine. _(source: default)_',
      );

      await user.click(within(ai()).getByRole('button', { name: 'Customize for this task' }));
      await user.selectOptions(push(), 'On');
      await user.click(within(ai()).getByRole('button', { name: 'Save' }));
      await within(ai()).findByText('Saved.');

      const changed = await copy();
      expect(changed).toContain('Push your commits to the remote. _(source: this task)_');
      expect(changed).toBe((await server.get('/api/v1/tasks/T1/handoff').expect(200)).text);

      await user.click(
        within(ai()).getByRole('button', { name: 'Reset to the settings of column todo' }),
      );
      await within(ai()).findByText(/Uses the settings of column todo/);
      expect(await copy()).toContain(
        'Do not push: nothing leaves this machine. _(source: default)_',
      );
    },
    SLOW_MS,
  );

  it(
    'copies the handoff of a task that must not change code, whatever else it has switched on',
    async () => {
      const { user, server } = await withTask();
      await server
        .patch('/api/v1/tasks/T1', { workflow: { editCode: false, push: true, commit: true } })
        .expect(200);
      await waitFor(() => expect(push()).toHaveAccessibleDescription(/Not used while/));

      await user.click(within(details()).getByRole('button', { name: 'Send to AI' }));
      await user.click(screen.getByRole('button', { name: 'Copy handoff' }));
      await within(details()).findByText('Handoff copied to the clipboard.');

      const text = await navigator.clipboard.readText();
      expect(text).toContain('Do not change any file of the project');
      expect(text).toContain('Do not push: there is nothing to push.');
      expect(text).toContain('Do not commit: there are no changes to commit.');
      expect(text).toBe((await server.get('/api/v1/tasks/T1/handoff').expect(200)).text);
    },
    SLOW_MS,
  );
});

describe('an edit and the world outside the page', () => {
  it(
    'takes a change made through the API into a block with nothing unsaved',
    async () => {
      const { server } = await withTask();

      await server.patch('/api/v1/tasks/T1', { workflow: { push: true } }).expect(200);

      expect(await within(ai()).findByLabelText(WORKFLOW_LABELS.push.label)).toHaveDisplayValue(
        'On',
      );
      expect(await within(ai()).findByText(/^In effect: on, from this task\./)).toBeInTheDocument();
    },
    SLOW_MS,
  );

  it(
    'keeps what is being edited when the task is changed through the API, and says so',
    async () => {
      const root = await tmpDir();
      const { user, server } = await withTask(root);
      await user.click(within(ai()).getByRole('button', { name: 'Customize for this task' }));
      await user.selectOptions(field(WORKFLOW_LABELS.report.label), 'Off');

      await server.patch('/api/v1/tasks/T1', { workflow: { push: true } }).expect(200);

      expect(await within(ai()).findByRole('status')).toHaveTextContent(/changed elsewhere/i);
      expect(field(WORKFLOW_LABELS.report.label)).toHaveDisplayValue('Off');
      expect(push()).toHaveDisplayValue(/^Inherit/);
      // Nothing was written by the page: the file is the other writer's.
      expect((await frontmatter(root)).workflow).toEqual({ push: true });
    },
    SLOW_MS,
  );

  it(
    'keeps everything typed when the board cannot be reached, and saves when it is back',
    async () => {
      const root = await tmpDir();
      const { user, server } = await withTask(root);
      await user.click(within(ai()).getByRole('button', { name: 'Customize for this task' }));
      await user.selectOptions(field(WORKFLOW_LABELS.report.label), 'Off');

      await server.close();
      await user.click(within(ai()).getByRole('button', { name: 'Save' }));

      expect(await within(ai()).findByRole('alert')).toBeInTheDocument();
      expect(field(WORKFLOW_LABELS.report.label)).toHaveDisplayValue('Off');
      expect(within(ai()).getByRole('button', { name: 'Save' })).toBeEnabled();
      expect(await frontmatter(root)).not.toHaveProperty('workflow');
    },
    SLOW_MS,
  );
});

describe('leaving a task with unsaved AI settings on a real board', () => {
  it(
    'Save in the question writes the overrides of the task to its file, then leaves',
    async () => {
      const root = await tmpDir();
      const { user } = await withTask(root);
      await user.click(within(ai()).getByRole('button', { name: 'Customize for this task' }));
      await user.selectOptions(push(), 'On');

      await user.click(within(details()).getByRole('button', { name: 'Close' }));
      const question = await screen.findByRole('dialog', { name: 'Unsaved changes' });
      await user.click(within(question).getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(screen.queryByRole('complementary', { name: 'Task T1' })).not.toBeInTheDocument(),
      );
      expect((await frontmatter(root)).workflow).toEqual({ push: true });
    },
    SLOW_MS,
  );

  it(
    'Save that the board cannot take keeps the panel and the change, and writes nothing',
    async () => {
      const root = await tmpDir();
      const { user, server } = await withTask(root);
      await user.click(within(ai()).getByRole('button', { name: 'Customize for this task' }));
      await user.selectOptions(push(), 'On');

      await server.close();
      await user.click(within(details()).getByRole('button', { name: 'Close' }));
      const question = await screen.findByRole('dialog', { name: 'Unsaved changes' });
      await user.click(within(question).getByRole('button', { name: 'Save' }));

      expect(await within(question).findByRole('alert')).toBeInTheDocument();
      await user.click(within(question).getByRole('button', { name: 'Cancel' }));
      expect(details()).toBeInTheDocument();
      expect(push()).toHaveDisplayValue('On');
      expect(await frontmatter(root)).not.toHaveProperty('workflow');
    },
    SLOW_MS,
  );
});
