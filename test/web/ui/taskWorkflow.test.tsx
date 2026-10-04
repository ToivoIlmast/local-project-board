import { jest } from '@jest/globals';
import { act, screen, waitFor, within } from '@testing-library/react';
import type { Task, WorkflowOverrides } from '../../../src/contract/v1/index';
import { WORKFLOW_FLAGS, type WorkflowFlag } from '../../../src/core/model/workflow';
import { SUPPORTED_LANGUAGES } from '../../../src/core/model/language';
import { ApiError } from '../../../src/web/api/index';
import { WORKFLOW_LABELS } from '../../../src/web/features/settings/index';
import { defaultWorkflow } from '../../../src/core/rules/workflow';
import { STATUSES, aTask } from '../support/fixtures';
import type { FakeBoardOptions } from '../support/fakeBoard';
import { renderBoard, type RenderedBoard } from '../support/render';

const todo = (extra: Partial<Task> = {}): Task =>
  aTask({ id: 'T1', title: 'Ship it', status: 'todo', ...extra });

/** Opens the task on a board that already has these overrides; T1 is in "todo" unless said. */
async function openTask(options: FakeBoardOptions = {}): Promise<RenderedBoard> {
  const rendered = await renderBoard({ tasks: [todo()], ...options });
  await rendered.user.click(screen.getByRole('button', { name: 'Ship it' }));
  await screen.findByRole('complementary', { name: 'Task T1' });
  return rendered;
}

const details = () => screen.getByRole('complementary', { name: 'Task T1' });
const ai = () => within(details()).getByRole('region', { name: 'AI' });
const field = (key: WorkflowFlag) => within(ai()).getByLabelText(WORKFLOW_LABELS[key].label);
const save = () => within(ai()).getByRole('button', { name: 'Save' });
const reset = (status = 'todo') =>
  within(ai()).getByRole('button', { name: `Reset to the settings of column ${status}` });
const customize = () => within(ai()).getByRole('button', { name: 'Customize for this task' });
const marked = () =>
  within(screen.getByRole('button', { name: 'Ship it' }).closest('li') as HTMLElement).queryByTitle(
    'This task has AI settings of its own',
  );

/** The value a row of "also in effect" shows: the text of its definition. */
const valueOf = (label: string): HTMLElement | null =>
  within(ai()).getByText(label).closest('div')?.querySelector('dd') ?? null;

const boardOverrides = (overrides: Partial<WorkflowOverrides>): WorkflowOverrides => ({
  board: {},
  statuses: {},
  ...overrides,
});

/** Opens the block of a task that has no overrides and waits for what is in effect. */
async function expandAndRead(rendered: RenderedBoard): Promise<void> {
  await rendered.user.click(customize());
  await waitFor(() => expect(field('editCode')).toHaveAccessibleDescription(/In effect/));
}

describe('the AI block of a task without settings of its own', () => {
  it('is one line that says which settings the task uses, and asks for nothing', async () => {
    await openTask();

    expect(within(ai()).getByRole('heading', { name: 'AI' })).toBeInTheDocument();
    expect(ai()).toHaveTextContent('Uses the settings of column todo');
    expect(within(ai()).queryAllByRole('combobox')).toHaveLength(0);
    expect(customize()).toHaveAttribute('aria-expanded', 'false');
  });

  it('names the column the task is in now, and follows the task to another one', async () => {
    const { board } = await openTask();

    await act(() => board.client.moveTask('T1', { status: 'in-progress' }));

    expect(ai()).toHaveTextContent('Uses the settings of column in-progress');
  });

  it('shows every setting with what it is now and where it comes from, once opened', async () => {
    const rendered = await openTask();

    await expandAndRead(rendered);

    // The button that opened it is now the one that closes it.
    expect(
      within(ai()).queryByRole('button', { name: 'Customize for this task' }),
    ).not.toBeInTheDocument();
    for (const [key, now] of [
      ['editCode', 'on'],
      ['branch', 'on'],
      ['checks', 'on'],
      ['commit', 'on'],
      ['push', 'off'],
      ['report', 'on'],
    ] as const) {
      expect(field(key)).toHaveDisplayValue(`Inherit (now ${now}, from the default)`);
      expect(field(key)).toHaveAccessibleDescription(`In effect: ${now}, from the default.`);
    }
  });

  it('shows the settings that only the board has, as what is in effect, not as controls', async () => {
    const rendered = await openTask({
      workflow: boardOverrides({ board: { checkCommand: 'npm test', finishStatus: 'done' } }),
    });

    await expandAndRead(rendered);

    expect(valueOf(WORKFLOW_LABELS.startStatus.label)).toHaveTextContent(
      'in-progress, from the default',
    );
    expect(valueOf(WORKFLOW_LABELS.finishStatus.label)).toHaveTextContent('done, from the board');
    expect(valueOf(WORKFLOW_LABELS.baseBranch.label)).toHaveTextContent(
      "the repository's default branch, from the default",
    );
    expect(valueOf(WORKFLOW_LABELS.checkCommand.label)).toHaveTextContent(
      'npm test, from the board',
    );
    // The task can override the six on/off settings and the report language, nothing else (T13, T34).
    expect(within(ai()).getAllByRole('combobox')).toHaveLength(WORKFLOW_FLAGS.length + 1);
    expect(valueOf(WORKFLOW_LABELS.reportLanguage.label)).toBeNull();
    expect(within(ai()).queryAllByRole('textbox')).toHaveLength(0);
  });

  it('shows the commit language as in effect, with its source, and offers no control for it (T43)', async () => {
    const rendered = await openTask({
      workflow: boardOverrides({ board: { commitLanguage: 'fi' } }),
    });

    await expandAndRead(rendered);

    expect(valueOf(WORKFLOW_LABELS.commitLanguage.label)).toHaveTextContent(
      'Finnish, from the board',
    );
    // Still the six flags and the report language: no control was added (T43, board only).
    expect(within(ai()).getAllByRole('combobox')).toHaveLength(WORKFLOW_FLAGS.length + 1);
    expect(
      within(ai()).queryByLabelText(WORKFLOW_LABELS.commitLanguage.label),
    ).not.toBeInTheDocument();
  });

  it('says that the commit language follows the convention of the project when it is not set (T43)', async () => {
    const rendered = await openTask();

    await expandAndRead(rendered);

    expect(valueOf(WORKFLOW_LABELS.commitLanguage.label)).toHaveTextContent(
      "the project's convention, from the default",
    );
  });

  it('does not send the commit language when a task is saved (T43, INVARIANT)', async () => {
    const rendered = await openTask({
      tasks: [todo({ workflow: { push: true } })],
      workflow: boardOverrides({ board: { commitLanguage: 'fi' } }),
    });
    const patch = jest.spyOn(rendered.board.client, 'updateTask');

    await rendered.user.selectOptions(field('report'), 'Off');
    await rendered.user.click(save());

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('T1', { workflow: { push: true, report: false } }),
    );
  });

  it('writes nothing just because it was opened (INVARIANT)', async () => {
    const rendered = await openTask({
      workflow: boardOverrides({ board: { push: true }, statuses: { todo: { report: false } } }),
    });

    await expandAndRead(rendered);

    expect(save()).toBeDisabled();
    expect(rendered.board.calls).not.toContain('updateTask');
    expect(rendered.board.tasks[0]?.workflow).toBeUndefined();
  });

  it('can be closed again', async () => {
    const rendered = await openTask();
    await expandAndRead(rendered);

    await rendered.user.click(within(ai()).getByRole('button', { name: 'Hide the AI settings' }));

    expect(within(ai()).queryAllByRole('combobox')).toHaveLength(0);
    expect(customize()).toBeInTheDocument();
  });

  it('is still one line when the file holds an empty workflow: that is no override', async () => {
    await openTask({ tasks: [todo({ workflow: {} })] });

    expect(ai()).toHaveTextContent('Uses the settings of column todo');
    expect(screen.queryByTitle('This task has AI settings of its own')).not.toBeInTheDocument();
  });
});

describe('where the value in effect comes from', () => {
  it('says the default, the board, the column and the task, each for what it is', async () => {
    await openTask({
      tasks: [todo({ workflow: { checks: false } })],
      workflow: boardOverrides({ board: { push: true }, statuses: { todo: { report: false } } }),
    });

    await waitFor(() =>
      expect(field('checks')).toHaveAccessibleDescription('In effect: off, from this task.'),
    );
    expect(field('push')).toHaveAccessibleDescription('In effect: on, from the board.');
    expect(field('report')).toHaveAccessibleDescription('In effect: off, from the column todo.');
    expect(field('commit')).toHaveAccessibleDescription('In effect: on, from the default.');
  });

  it('uses the column of the status the task has, not another one', async () => {
    const rendered = await openTask({
      tasks: [todo({ status: 'in-progress' })],
      workflow: boardOverrides({
        statuses: { todo: { push: true }, 'in-progress': { push: false, report: false } },
      }),
    });

    await expandAndRead(rendered);

    expect(field('push')).toHaveAccessibleDescription(
      'In effect: off, from the column in-progress.',
    );
    expect(field('report')).toHaveAccessibleDescription(
      'In effect: off, from the column in-progress.',
    );
  });

  it('follows the column when it is changed elsewhere, without a reload', async () => {
    const rendered = await openTask({ tasks: [todo({ workflow: { report: false } })] });
    await waitFor(() => expect(field('push')).toHaveAccessibleDescription(/from the default/));

    rendered.board.workflow.statuses = { todo: { push: true } };
    act(() =>
      rendered.board.emit({
        type: 'workflow.updated',
        workflow: {
          defaults: defaultWorkflow(STATUSES),
          ...structuredClone(rendered.board.workflow),
        },
      }),
    );

    await waitFor(() =>
      expect(field('push')).toHaveAccessibleDescription('In effect: on, from the column todo.'),
    );
    expect(field('push')).toHaveDisplayValue('Inherit (now on, from the column todo)');
  });

  it('does not show an old answer as the new one while the board works it out again (INVARIANT)', async () => {
    const rendered = await openTask({
      tasks: [todo({ workflow: { report: false } })],
      workflow: boardOverrides({ statuses: { 'in-progress': { push: true } } }),
    });
    await waitFor(() => expect(field('push')).toHaveAccessibleDescription(/from the default/));
    const release = rendered.board.hold('taskWorkflow');

    await act(() => rendered.board.client.moveTask('T1', { status: 'in-progress' }));

    // What was true of column todo is not said of column in-progress.
    expect(field('push')).toHaveAccessibleDescription('Reading what is in effect…');
    act(() => release());
    await waitFor(() =>
      expect(field('push')).toHaveAccessibleDescription(
        'In effect: on, from the column in-progress.',
      ),
    );
  });

  it('follows the task to another column: the effective settings depend on the status', async () => {
    const rendered = await openTask({
      tasks: [todo({ workflow: { report: false } })],
      workflow: boardOverrides({ statuses: { 'in-progress': { push: true } } }),
    });
    await waitFor(() => expect(field('push')).toHaveAccessibleDescription(/from the default/));

    await act(() => rendered.board.client.moveTask('T1', { status: 'in-progress' }));

    await waitFor(() =>
      expect(field('push')).toHaveAccessibleDescription(
        'In effect: on, from the column in-progress.',
      ),
    );
    expect(field('report')).toHaveAccessibleDescription('In effect: off, from this task.');
  });
});

describe('a task with settings of its own', () => {
  it('opens the block by itself and shows what the task sets', async () => {
    await openTask({ tasks: [todo({ workflow: { push: true, report: false } })] });

    expect(field('push')).toHaveDisplayValue('On');
    expect(field('report')).toHaveDisplayValue('Off');
    expect(field('checks')).toHaveDisplayValue(/^Inherit/);
    // Nothing to fold away: the exceptions of a task are not hidden from whoever opens it.
    expect(
      within(ai()).queryByRole('button', { name: /^Customize|^Hide/ }),
    ).not.toBeInTheDocument();
  });

  it('has a mark on its card, and the card of a task without settings does not', async () => {
    await renderBoard({
      tasks: [
        todo({ workflow: { push: false } }),
        aTask({ id: 'T2', title: 'Plain', status: 'todo', rank: 'a1' }),
        aTask({ id: 'T3', title: 'Empty', status: 'todo', rank: 'a2', workflow: {} }),
      ],
    });

    const markOf = (title: string) =>
      within(screen.getByRole('button', { name: title }).closest('li') as HTMLElement).queryByTitle(
        'This task has AI settings of its own',
      );
    expect(markOf('Ship it')).toBeInTheDocument();
    expect(markOf('Ship it')).toHaveTextContent(/AI settings/);
    expect(markOf('Plain')).not.toBeInTheDocument();
    expect(markOf('Empty')).not.toBeInTheDocument();
  });

  it('puts the mark on and takes it off as the settings are saved and reset', async () => {
    const { user } = await openTask();
    expect(marked()).not.toBeInTheDocument();

    await user.click(customize());
    await user.selectOptions(field('push'), 'On');
    await user.click(save());
    await within(ai()).findByText('Saved.');
    expect(marked()).toBeInTheDocument();

    await user.click(reset());
    await waitFor(() => expect(marked()).not.toBeInTheDocument());
  });
});

describe('changing one setting of a task', () => {
  it('sends the task overrides and nothing else, and leaves the board and the columns alone', async () => {
    const stored = boardOverrides({
      board: { push: true, checkCommand: 'npm test' },
      statuses: { todo: { report: false } },
    });
    const rendered = await openTask({ workflow: structuredClone(stored) });
    const patch = jest.spyOn(rendered.board.client, 'updateTask');
    await expandAndRead(rendered);

    await rendered.user.selectOptions(field('commit'), 'Off');
    await rendered.user.click(save());
    await within(ai()).findByText('Saved.');

    // Effective values (push on, report off, the command…) are results: none of them is sent.
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith('T1', { workflow: { commit: false } });
    expect(rendered.board.tasks[0]?.workflow).toEqual({ commit: false });
    expect(rendered.board.workflow).toEqual(stored);
    expect(rendered.board.calls).not.toContain('updateWorkflow');
  });

  it('keeps the settings the task already had, because a task’s overrides are replaced whole', async () => {
    const rendered = await openTask({ tasks: [todo({ workflow: { push: true } })] });
    const patch = jest.spyOn(rendered.board.client, 'updateTask');

    await rendered.user.selectOptions(field('report'), 'Off');
    await rendered.user.click(save());
    await within(ai()).findByText('Saved.');

    expect(patch).toHaveBeenCalledWith('T1', { workflow: { push: true, report: false } });
  });

  it('changes nothing else about the task', async () => {
    const rendered = await openTask({
      tasks: [todo({ body: 'Some words', labels: ['ai'], branch: 'task/T1-ship-it' })],
    });
    await expandAndRead(rendered);
    const before = structuredClone(rendered.board.tasks[0]);

    await rendered.user.selectOptions(field('push'), 'On');
    await rendered.user.click(save());
    await within(ai()).findByText('Saved.');

    const { workflow, updatedAt: _touched, ...after } = rendered.board.tasks[0] as Task;
    const { updatedAt: _was, ...was } = before as Task;
    expect(workflow).toEqual({ push: true });
    expect(after).toEqual(was);
  });

  it('shows the new value as coming from the task once the board has answered', async () => {
    const rendered = await openTask({ workflow: boardOverrides({ board: { push: false } }) });
    await expandAndRead(rendered);
    expect(field('push')).toHaveAccessibleDescription('In effect: off, from the board.');

    await rendered.user.selectOptions(field('push'), 'On');
    await rendered.user.click(save());

    await waitFor(() =>
      expect(field('push')).toHaveAccessibleDescription('In effect: on, from this task.'),
    );
    expect(field('push')).toHaveDisplayValue('On');
    // What it would fall back to is still said.
    expect(
      within(ai()).getByRole('option', { name: 'Inherit (now off, from the board)' }),
    ).toBeInTheDocument();
  });

  it('does not offer to save what has not changed, and choosing the old value again undoes the change', async () => {
    const rendered = await openTask({ tasks: [todo({ workflow: { push: true } })] });
    expect(save()).toBeDisabled();

    await rendered.user.selectOptions(field('push'), 'Off');
    expect(save()).toBeEnabled();
    await rendered.user.selectOptions(field('push'), 'On');
    expect(save()).toBeDisabled();

    await rendered.user.selectOptions(field('report'), 'Off');
    await rendered.user.selectOptions(field('report'), 'inherit');
    expect(save()).toBeDisabled();
    expect(rendered.board.calls).not.toContain('updateTask');
  });

  it('says that a value has not been saved yet, where it is', async () => {
    const rendered = await openTask({ tasks: [todo({ workflow: { push: true } })] });
    await waitFor(() => expect(field('push')).toHaveAccessibleDescription(/In effect/));

    await rendered.user.selectOptions(field('push'), 'Off');

    expect(field('push')).toHaveAccessibleDescription(/Not saved yet/);
    expect(field('report')).not.toHaveAccessibleDescription(/Not saved yet/);
  });

  it('shows nothing new before the board has answered (no optimistic update)', async () => {
    const rendered = await openTask();
    await expandAndRead(rendered);
    const release = rendered.board.hold('updateTask');

    await rendered.user.selectOptions(field('push'), 'On');
    await rendered.user.click(save());

    expect(await within(ai()).findByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(rendered.board.tasks[0]?.workflow).toBeUndefined();
    expect(screen.queryByTitle('This task has AI settings of its own')).not.toBeInTheDocument();

    act(() => release());
    expect(await within(ai()).findByText('Saved.')).toBeInTheDocument();
    expect(screen.getByTitle('This task has AI settings of its own')).toBeInTheDocument();
  });

  it('is done with the keyboard alone', async () => {
    const { user } = await openTask();

    customize().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(field('editCode')).toBeInTheDocument());
    // A native select changes with the keyboard; user-event drives it the way the keys would.
    field('push').focus();
    await user.selectOptions(field('push'), 'On');
    save().focus();
    await user.keyboard('{Enter}');

    expect(await within(ai()).findByText('Saved.')).toBeInTheDocument();
    expect(field('push')).toHaveDisplayValue('On');
  });
});

const language = () => within(ai()).getByLabelText(WORKFLOW_LABELS.reportLanguage.label);

describe('the report language of a task (T34)', () => {
  it('offers "like the board" and every one of the 14 languages, and says it is the agent’s report', async () => {
    const rendered = await openTask({
      workflow: boardOverrides({ board: { reportLanguage: 'sv' } }),
    });
    await expandAndRead(rendered);

    expect(language()).toHaveDisplayValue('Like the board (now Swedish, from the board)');
    const values = within(language())
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);
    expect(values).toEqual(['inherit', ...SUPPORTED_LANGUAGES]);
    expect(WORKFLOW_LABELS.reportLanguage.description).toMatch(/report/i);
    expect(WORKFLOW_LABELS.reportLanguage.description).toMatch(/not .*language of this page/i);
  });

  it('PATCHes workflow with the chosen language and keeps the other overrides of the task', async () => {
    const rendered = await openTask({ tasks: [todo({ workflow: { push: true } })] });
    const patch = jest.spyOn(rendered.board.client, 'updateTask');

    await rendered.user.selectOptions(language(), 'fi');
    await rendered.user.click(save());
    await within(ai()).findByText('Saved.');

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith('T1', { workflow: { push: true, reportLanguage: 'fi' } });
    expect(language()).toHaveDisplayValue('Finnish');
    expect(language()).toHaveAccessibleDescription(/In effect: Finnish, from this task/);
  });

  it('shows the language that is saved after a reload', async () => {
    await openTask({ tasks: [todo({ workflow: { reportLanguage: 'ja' } })] });

    expect(language()).toHaveDisplayValue('Japanese');
  });

  it('"like the board" removes the key, and the last key going sends null (INVARIANT)', async () => {
    const rendered = await openTask({
      tasks: [todo({ workflow: { push: true, reportLanguage: 'fi' } })],
    });
    const patch = jest.spyOn(rendered.board.client, 'updateTask');

    await rendered.user.selectOptions(language(), 'inherit');
    await rendered.user.click(save());
    await within(ai()).findByText('Saved.');
    expect(patch).toHaveBeenLastCalledWith('T1', { workflow: { push: true } });
    expect(rendered.board.tasks[0]?.workflow).toEqual({ push: true });

    await rendered.user.selectOptions(field('push'), 'inherit');
    await rendered.user.click(save());
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith('T1', { workflow: null }));
  });

  it('English on a task is a value of its own, not the same as "like the board"', async () => {
    const rendered = await openTask({
      workflow: boardOverrides({ board: { reportLanguage: 'sv' } }),
    });
    const patch = jest.spyOn(rendered.board.client, 'updateTask');
    await expandAndRead(rendered);

    await rendered.user.selectOptions(language(), 'en');
    await rendered.user.click(save());

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('T1', { workflow: { reportLanguage: 'en' } }),
    );
  });
});

describe('taking the settings of a task away', () => {
  it('takes one setting out and keeps the others', async () => {
    const rendered = await openTask({ tasks: [todo({ workflow: { push: true, report: false } })] });
    const patch = jest.spyOn(rendered.board.client, 'updateTask');

    await rendered.user.selectOptions(field('push'), 'inherit');
    await rendered.user.click(save());
    await within(ai()).findByText('Saved.');

    expect(patch).toHaveBeenCalledWith('T1', { workflow: { report: false } });
    expect(rendered.board.tasks[0]?.workflow).toEqual({ report: false });
  });

  it('sends null, not an empty object, when the last setting goes (INVARIANT)', async () => {
    const rendered = await openTask({ tasks: [todo({ workflow: { push: true } })] });
    const patch = jest.spyOn(rendered.board.client, 'updateTask');

    await rendered.user.selectOptions(field('push'), 'inherit');
    await rendered.user.click(save());

    await waitFor(() => expect(patch).toHaveBeenCalledWith('T1', { workflow: null }));
    expect('workflow' in (rendered.board.tasks[0] as Task)).toBe(false);
    // The block is the one line again, and the focus is not lost with the button that was pressed.
    expect(await within(ai()).findByText(/Uses the settings of column todo/)).toBeInTheDocument();
    await waitFor(() => expect(customize()).toHaveFocus());
  });

  it('resets the whole block with one button, by sending null (INVARIANT)', async () => {
    const rendered = await openTask({
      tasks: [todo({ workflow: { push: true, report: false, editCode: true } })],
    });
    const patch = jest.spyOn(rendered.board.client, 'updateTask');

    await rendered.user.click(reset());

    await waitFor(() => expect(patch).toHaveBeenCalledWith('T1', { workflow: null }));
    await waitFor(() => expect('workflow' in (rendered.board.tasks[0] as Task)).toBe(false));
    // With nothing left, the block is the one line again.
    expect(await within(ai()).findByText(/Uses the settings of column todo/)).toBeInTheDocument();
    await waitFor(() => expect(customize()).toHaveFocus());
  });

  it('has nothing to reset on a task without settings', async () => {
    const rendered = await openTask();
    await expandAndRead(rendered);

    expect(reset()).toBeDisabled();
  });

  it('gives the task back what the column, the board and the default say, key by key', async () => {
    const rendered = await openTask({
      tasks: [todo({ workflow: { push: false, report: true, checks: false, commit: false } })],
      workflow: boardOverrides({
        board: { push: true, commit: false },
        statuses: { todo: { report: false, commit: true } },
      }),
    });
    await waitFor(() =>
      expect(field('commit')).toHaveAccessibleDescription('In effect: off, from this task.'),
    );

    await rendered.user.click(reset());

    // Nothing is left to show but the line; open it to see what the task inherits now.
    await rendered.user.click(
      await within(ai()).findByRole('button', { name: 'Customize for this task' }),
    );
    // push: board says on; report: the column says off; commit: the column beats the board;
    // checks: nobody says anything, so the default.
    await waitFor(() =>
      expect(field('push')).toHaveAccessibleDescription('In effect: on, from the board.'),
    );
    expect(field('report')).toHaveAccessibleDescription('In effect: off, from the column todo.');
    expect(field('commit')).toHaveAccessibleDescription('In effect: on, from the column todo.');
    expect(field('checks')).toHaveAccessibleDescription('In effect: on, from the default.');
    // And the board and the columns are exactly as they were.
    expect(rendered.board.workflow).toEqual({
      board: { push: true, commit: false },
      statuses: { todo: { report: false, commit: true } },
    });
  });

  it('discards what was typed but not saved when the block is reset', async () => {
    const rendered = await openTask({ tasks: [todo({ workflow: { push: true } })] });
    await rendered.user.selectOptions(field('report'), 'Off');

    await rendered.user.click(reset());

    await waitFor(() => expect('workflow' in (rendered.board.tasks[0] as Task)).toBe(false));
    expect(within(ai()).queryByText(/Not saved yet/)).not.toBeInTheDocument();
  });
});

describe('when editing code is off', () => {
  it('mutes the settings that depend on it, explains why, and keeps their values', async () => {
    await openTask({
      tasks: [todo({ workflow: { push: true } })],
      workflow: boardOverrides({ statuses: { todo: { editCode: false } } }),
    });

    await waitFor(() =>
      expect(field('editCode')).toHaveAccessibleDescription(
        'In effect: off, from the column todo.',
      ),
    );
    for (const key of ['branch', 'checks', 'commit', 'push'] as const) {
      expect(field(key)).toHaveAccessibleDescription(/Not used while “Edit code” is off/);
      expect(field(key)).toBeEnabled();
    }
    expect(field('report')).not.toHaveAccessibleDescription(/Not used while/);
    // Nothing is rewritten because they do not matter now.
    expect(field('push')).toHaveDisplayValue('On');
    expect(field('branch')).toHaveDisplayValue('Inherit (now on, from the default)');
  });

  it('does the same when it is the task that turns it off, and un-mutes when it is on again', async () => {
    const rendered = await openTask({ tasks: [todo({ workflow: { editCode: false } })] });

    await waitFor(() =>
      expect(field('editCode')).toHaveAccessibleDescription('In effect: off, from this task.'),
    );
    expect(field('push')).toHaveAccessibleDescription(/Not used while “Edit code” is off/);

    await rendered.user.selectOptions(field('editCode'), 'On');
    await rendered.user.click(save());
    await within(ai()).findByText('Saved.');

    await waitFor(() => expect(field('push')).not.toHaveAccessibleDescription(/Not used while/));
    expect(field('editCode')).toHaveAccessibleDescription('In effect: on, from this task.');
  });

  it('follows the board’s answer, not a guess: nothing is muted before the board has said so', async () => {
    const rendered = await openTask();
    await expandAndRead(rendered);

    await rendered.user.selectOptions(field('editCode'), 'Off');

    // Unsaved: still what the board computed.
    expect(field('push')).not.toHaveAccessibleDescription(/Not used while/);
    await rendered.user.click(save());
    await waitFor(() =>
      expect(field('push')).toHaveAccessibleDescription(/Not used while “Edit code” is off/),
    );
  });
});

describe('when the board refuses or cannot be read', () => {
  it('shows what the board said and keeps everything typed, then saves on the next try', async () => {
    const rendered = await openTask({ tasks: [todo({ workflow: { push: true } })] });
    rendered.board.fail(
      'updateTask',
      new ApiError(500, 'INTERNAL_ERROR', 'The board could not write the task.'),
    );

    await rendered.user.selectOptions(field('report'), 'Off');
    await rendered.user.click(save());

    expect(await within(ai()).findByRole('alert')).toHaveTextContent('could not write the task');
    expect(field('report')).toHaveDisplayValue('Off');
    expect(field('push')).toHaveDisplayValue('On');
    expect(save()).toBeEnabled();
    expect(within(ai()).queryByText('Saved.')).not.toBeInTheDocument();
    expect(rendered.board.tasks[0]?.workflow).toEqual({ push: true });

    await rendered.user.click(save());

    expect(await within(ai()).findByText('Saved.')).toBeInTheDocument();
    expect(within(ai()).queryByRole('alert')).not.toBeInTheDocument();
    expect(rendered.board.tasks[0]?.workflow).toEqual({ push: true, report: false });
  });

  it('shows the refusal of a reset and leaves the block as it was', async () => {
    const rendered = await openTask({ tasks: [todo({ workflow: { push: true } })] });
    rendered.board.fail('updateTask', new ApiError(500, 'INTERNAL_ERROR', 'Nothing was written.'));

    await rendered.user.selectOptions(field('report'), 'Off');
    await rendered.user.click(reset());

    expect(await within(ai()).findByRole('alert')).toHaveTextContent('Nothing was written');
    expect(field('report')).toHaveDisplayValue('Off');
    expect(field('push')).toHaveDisplayValue('On');
  });

  it('says so when the settings in effect cannot be read, and lets the person try again', async () => {
    const rendered = await openTask();
    rendered.board.fail(
      'taskWorkflow',
      new ApiError(500, 'INTERNAL_ERROR', 'The settings could not be worked out.'),
    );

    await rendered.user.click(customize());

    const alert = await within(ai()).findByRole('alert');
    expect(alert).toHaveTextContent('The settings could not be worked out');
    // The controls are still there and still say what they inherit; nothing is invented.
    expect(field('push')).toHaveDisplayValue('Inherit (now off, from the default)');
    expect(field('push')).not.toHaveAccessibleDescription(/In effect/);

    await rendered.user.click(within(alert).getByRole('button', { name: 'Try again' }));

    await waitFor(() =>
      expect(field('push')).toHaveAccessibleDescription('In effect: off, from the default.'),
    );
    expect(within(ai()).queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('when the task is changed outside this page', () => {
  const elsewhere = (board: RenderedBoard['board'], workflow: Task['workflow']): void => {
    const task = { ...(board.tasks[0] as Task) };
    if (workflow === undefined) delete task.workflow;
    else task.workflow = workflow;
    act(() => board.emit({ type: 'task.updated', task }));
  };

  it('updates a block with nothing unsaved, silently', async () => {
    const { board } = await openTask({ tasks: [todo({ workflow: { push: true } })] });

    elsewhere(board, { push: false, checks: false });

    await waitFor(() => expect(field('push')).toHaveDisplayValue('Off'));
    expect(field('checks')).toHaveDisplayValue('Off');
    expect(within(ai()).queryByText(/changed elsewhere/i)).not.toBeInTheDocument();
  });

  it('opens the block when another window gives a task its first settings', async () => {
    const { board } = await openTask();
    expect(ai()).toHaveTextContent('Uses the settings of column todo');

    elsewhere(board, { push: true });

    expect(await within(ai()).findByLabelText(WORKFLOW_LABELS.push.label)).toHaveDisplayValue('On');
  });

  it('goes back to one line when another window takes the settings away', async () => {
    const { board } = await openTask({ tasks: [todo({ workflow: { push: true } })] });

    elsewhere(board, undefined);

    expect(await within(ai()).findByText(/Uses the settings of column todo/)).toBeInTheDocument();
  });

  it('does not overwrite what is being edited: it says so and lets the person choose (INVARIANT)', async () => {
    const { user, board } = await openTask({ tasks: [todo({ workflow: { push: true } })] });
    await user.selectOptions(field('report'), 'Off');

    elsewhere(board, { push: true, checks: false });

    const notice = await within(ai()).findByRole('status');
    expect(notice).toHaveTextContent(/changed elsewhere/i);
    expect(field('report')).toHaveDisplayValue('Off');
    expect(field('checks')).toHaveDisplayValue(/^Inherit/);
    expect(save()).toBeEnabled();

    await user.click(within(notice).getByRole('button', { name: 'Load the new settings' }));

    expect(field('report')).toHaveDisplayValue(/^Inherit/);
    expect(field('checks')).toHaveDisplayValue('Off');
    expect(within(ai()).queryByRole('status')).not.toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it('lets a person who ignores the notice save their own version: last write wins', async () => {
    const { user, board } = await openTask({ tasks: [todo({ workflow: { push: true } })] });
    await user.selectOptions(field('report'), 'Off');
    elsewhere(board, { checks: false });
    await within(ai()).findByRole('status');

    await user.click(save());

    await within(ai()).findByText('Saved.');
    expect(board.tasks[0]?.workflow).toEqual({ push: true, report: false });
    expect(within(ai()).queryByText(/changed elsewhere/i)).not.toBeInTheDocument();
  });

  it('does not take its own save for somebody else’s change', async () => {
    const { user } = await openTask();
    await user.click(customize());
    await user.selectOptions(field('push'), 'On');

    await user.click(save());
    await within(ai()).findByText('Saved.');

    expect(within(ai()).queryByText(/changed elsewhere/i)).not.toBeInTheDocument();
  });

  it('is not disturbed by the board being read again with the same settings', async () => {
    const { user, store } = await openTask({ tasks: [todo({ workflow: { push: true } })] });
    await user.selectOptions(field('report'), 'Off');

    // Any file edited on disk makes the page read the whole board again.
    await act(() => store.handleEvent({ type: 'board.changed' }));

    expect(field('report')).toHaveDisplayValue('Off');
    expect(within(ai()).queryByText(/changed elsewhere/i)).not.toBeInTheDocument();
  });

  it('keeps what is edited when the task is moved to another column meanwhile', async () => {
    const { user, board } = await openTask({
      tasks: [todo({ workflow: { push: true } })],
      workflow: boardOverrides({ statuses: { 'in-progress': { checks: false } } }),
    });
    await user.selectOptions(field('report'), 'Off');

    await act(() => board.client.moveTask('T1', { status: 'in-progress' }));

    expect(field('report')).toHaveDisplayValue('Off');
    expect(within(ai()).queryByText(/changed elsewhere/i)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(field('checks')).toHaveAccessibleDescription(
        'In effect: off, from the column in-progress.',
      ),
    );
  });
});

describe('for a keyboard and a screen reader', () => {
  it('gives every control a name and a description, and one group for the settings', async () => {
    await openTask({ tasks: [todo({ workflow: { push: true } })] });
    await waitFor(() => expect(field('push')).toHaveAccessibleDescription(/In effect/));

    const controls = [
      ...within(ai()).getAllByRole('combobox'),
      ...within(ai()).getAllByRole('button'),
    ];
    for (const control of controls) expect(control).toHaveAccessibleName();
    for (const select of within(ai()).getAllByRole('combobox')) {
      expect(select).toHaveAccessibleDescription();
    }
    expect(
      within(ai()).getByRole('group', { name: 'AI settings of this task' }),
    ).toBeInTheDocument();
  });

  it('is reached in reading order: the six settings, the language, then save, then reset', async () => {
    const { user } = await openTask({ tasks: [todo({ workflow: { push: true } })] });
    await user.selectOptions(field('report'), 'Off');

    field('editCode').focus();
    const order: (string | null)[] = [];
    for (let step = 0; step < 9; step += 1) {
      order.push(document.activeElement?.id || document.activeElement?.textContent || null);
      await user.tab();
    }

    expect(order).toEqual([
      ...(['editCode', 'branch', 'checks', 'commit', 'push', 'report'] as const).map(
        (key) => field(key).id,
      ),
      language().id,
      'Save',
      'Reset to the settings of column todo',
    ]);
  });

  it('does not tell on from off by colour alone', async () => {
    await openTask({ tasks: [todo({ workflow: { push: true, report: false } })] });

    expect(field('push')).toHaveDisplayValue('On');
    expect(field('report')).toHaveDisplayValue('Off');
  });

  it('says that the settings were saved to a screen reader, without moving the focus', async () => {
    const { user } = await openTask({ tasks: [todo({ workflow: { push: true } })] });
    await user.selectOptions(field('report'), 'Off');

    await user.click(save());

    const saved = await within(ai()).findByText('Saved.');
    expect(saved).toHaveAttribute('aria-live', 'polite');
    expect(field('report')).toBeInTheDocument();
  });
});
