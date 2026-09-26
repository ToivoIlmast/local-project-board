import { jest } from '@jest/globals';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task } from '../../../src/contract/v1/index';
import { ApiError } from '../../../src/web/api/index';
import { BoardProvider } from '../../../src/web/api/react';
import { TaskAiSettings } from '../../../src/web/features/tasks/index';
import {
  UnsavedChangesProvider,
  useLeaveGuard,
} from '../../../src/web/shared/hooks/unsavedChanges';
import { WORKFLOW_LABELS } from '../../../src/web/features/settings/index';
import { aTask } from '../support/fixtures';
import { fakeBoard, type FakeBoardOptions } from '../support/fakeBoard';
import { renderBoard, type RenderedBoard } from '../support/render';

const one = (extra: Partial<Task> = {}): Task =>
  aTask({ id: 'T1', title: 'Ship it', status: 'todo', rank: 'a0', ...extra });
const two = (): Task => aTask({ id: 'T2', title: 'Other task', status: 'todo', rank: 'a1' });

async function openTask(options: FakeBoardOptions = {}): Promise<RenderedBoard> {
  const rendered = await renderBoard({ tasks: [one(), two()], ...options });
  await rendered.user.click(screen.getByRole('button', { name: 'Ship it' }));
  await screen.findByRole('complementary', { name: 'Task T1' });
  // Opened, so that there is something to change; a task without settings shows one line.
  const block = within(screen.getByRole('complementary', { name: 'Task T1' }));
  const customize = block.queryByRole('button', { name: 'Customize for this task' });
  if (customize !== null) await rendered.user.click(customize);
  return rendered;
}

const details = () => screen.getByRole('complementary', { name: 'Task T1' });
const ai = () => within(details()).getByRole('region', { name: 'AI' });
const push = () => within(ai()).getByLabelText(WORKFLOW_LABELS.push.label);
const dialog = () => screen.getByRole('dialog', { name: 'Unsaved changes' });
const choice = (name: string) => within(dialog()).getByRole('button', { name });
const openedTask = () => new URLSearchParams(window.location.search).get('task');
const openedPanel = () => new URLSearchParams(window.location.search).get('panel');

/** Ways out of the panel of a task: each one has to ask. */
const WAYS_OUT: [string, (rendered: RenderedBoard) => Promise<void>, () => boolean][] = [
  [
    'the Close button of the panel',
    ({ user }) => user.click(within(details()).getByRole('button', { name: 'Close' })),
    () => openedTask() === null && openedPanel() === null,
  ],
  [
    'another card',
    ({ user }) => user.click(screen.getByRole('button', { name: 'Other task' })),
    () => openedTask() === 'T2',
  ],
  [
    'Open in the menu of another card',
    async ({ user }) => {
      await user.click(screen.getByRole('button', { name: 'Actions for T2' }));
      await user.click(screen.getByRole('button', { name: 'Open' }));
    },
    () => openedTask() === 'T2',
  ],
  [
    'a panel of the header',
    ({ user }) => user.click(screen.getByRole('button', { name: 'Reports' })),
    () => openedTask() === null && openedPanel() === 'reports',
  ],
  [
    'the Settings button of the header',
    ({ user }) => user.click(screen.getByRole('button', { name: 'Settings' })),
    () => openedTask() === null && openedPanel() === 'settings',
  ],
];

describe('leaving a task whose AI settings have unsaved changes', () => {
  describe.each(WAYS_OUT)('by %s', (_name, leave, arrived) => {
    it('asks first, and stays where it is until the answer', async () => {
      const rendered = await openTask();
      await rendered.user.selectOptions(push(), 'On');

      await leave(rendered);

      expect(dialog()).toHaveTextContent('You have unsaved changes to the AI settings of T1.');
      expect(arrived()).toBe(false);
      expect(details()).toBeInTheDocument();
    });

    it('Save: sends the overrides, then goes', async () => {
      const rendered = await openTask();
      const patch = jest.spyOn(rendered.board.client, 'updateTask');
      await rendered.user.selectOptions(push(), 'On');
      await leave(rendered);

      await rendered.user.click(choice('Save'));

      await waitFor(() => expect(arrived()).toBe(true));
      expect(patch).toHaveBeenCalledWith('T1', { workflow: { push: true } });
      expect(rendered.board.tasks[0]?.workflow).toEqual({ push: true });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('Save that fails: nothing closes and nothing is lost (INVARIANT)', async () => {
      const rendered = await openTask();
      rendered.board.fail(
        'updateTask',
        new ApiError(500, 'INTERNAL_ERROR', 'The board could not write the task.'),
      );
      await rendered.user.selectOptions(push(), 'On');
      await leave(rendered);

      await rendered.user.click(choice('Save'));

      expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
        'could not write the task',
      );
      expect(arrived()).toBe(false);
      expect(push()).toHaveDisplayValue('On');
      expect(rendered.board.tasks[0]?.workflow).toBeUndefined();

      // Back to the form: the change is there, with the error next to it.
      await rendered.user.click(choice('Cancel'));
      expect(push()).toHaveDisplayValue('On');
      expect(within(ai()).getByRole('alert')).toHaveTextContent('could not write the task');
      expect(within(ai()).getByRole('button', { name: 'Save' })).toBeEnabled();

      // And the way out works once the board answers.
      await leave(rendered);
      await rendered.user.click(choice('Save'));
      await waitFor(() => expect(arrived()).toBe(true));
      expect(rendered.board.tasks[0]?.workflow).toEqual({ push: true });
    });

    it('Discard: sends nothing, and goes', async () => {
      const rendered = await openTask();
      await rendered.user.selectOptions(push(), 'On');
      await leave(rendered);

      await rendered.user.click(choice('Discard'));

      await waitFor(() => expect(arrived()).toBe(true));
      expect(rendered.board.calls).not.toContain('updateTask');
      expect(rendered.board.tasks[0]?.workflow).toBeUndefined();
    });

    it('Cancel: stays, with the change in the form', async () => {
      const rendered = await openTask();
      await rendered.user.selectOptions(push(), 'On');
      await leave(rendered);

      await rendered.user.click(choice('Cancel'));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(arrived()).toBe(false);
      expect(push()).toHaveDisplayValue('On');
      expect(within(ai()).getByRole('button', { name: 'Save' })).toBeEnabled();
      expect(rendered.board.calls).not.toContain('updateTask');
    });

    it('does not ask when nothing is unsaved (INVARIANT)', async () => {
      const rendered = await openTask();

      await leave(rendered);

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(arrived()).toBe(true));
    });

    it('does not ask when the change was put back, or was saved', async () => {
      const rendered = await openTask();
      await rendered.user.selectOptions(push(), 'On');
      await rendered.user.selectOptions(push(), 'inherit');
      await leave(rendered);

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(arrived()).toBe(true));
    });
  });

  it('does not ask after the settings were saved with the button of the form', async () => {
    const rendered = await openTask();
    await rendered.user.selectOptions(push(), 'On');
    await rendered.user.click(within(ai()).getByRole('button', { name: 'Save' }));
    await within(ai()).findByText('Saved.');

    await rendered.user.click(within(details()).getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(openedTask()).toBeNull();
  });

  it('does not ask when the same task is opened again: nothing is left', async () => {
    const rendered = await openTask();
    await rendered.user.selectOptions(push(), 'On');

    await rendered.user.click(screen.getByRole('button', { name: 'Ship it' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(push()).toHaveDisplayValue('On');
  });

  it('does not ask when the task itself is deleted: there is nothing left to save to', async () => {
    const rendered = await openTask();
    await rendered.user.selectOptions(push(), 'On');

    await rendered.user.click(within(details()).getByRole('button', { name: 'Delete' }));
    await rendered.user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }),
    );

    await waitFor(() => expect(openedTask()).toBeNull());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Discard drops the change for good: the task comes back as it is on the board', async () => {
    const rendered = await openTask();
    await rendered.user.selectOptions(push(), 'On');
    await rendered.user.click(screen.getByRole('button', { name: 'Other task' }));
    await rendered.user.click(choice('Discard'));

    await rendered.user.click(await screen.findByRole('button', { name: 'Ship it' }));
    await rendered.user.click(
      within(ai()).getByRole('button', { name: 'Customize for this task' }),
    );

    expect(push()).toHaveDisplayValue(/^Inherit/);
  });

  it('says that the settings were also changed elsewhere, because Save replaces that change', async () => {
    const rendered = await openTask({ tasks: [one({ workflow: { report: false } }), two()] });
    await rendered.user.selectOptions(push(), 'On');
    act(() =>
      rendered.board.emit({
        type: 'task.updated',
        task: { ...(rendered.board.tasks[0] as Task), workflow: { report: false, checks: false } },
      }),
    );
    await within(ai()).findByRole('status');

    await rendered.user.click(within(details()).getByRole('button', { name: 'Close' }));

    expect(dialog()).toHaveTextContent(/changed elsewhere/i);
    expect(dialog()).toHaveTextContent(/replaces/i);
  });

  it('has the dialog for the keyboard: it starts on Save, Escape cancels, and the focus goes back', async () => {
    const rendered = await openTask();
    await rendered.user.selectOptions(push(), 'On');
    const close = within(details()).getByRole('button', { name: 'Close' });
    close.focus();
    await rendered.user.keyboard('{Enter}');

    expect(choice('Save')).toHaveFocus();
    await rendered.user.tab();
    expect(choice('Discard')).toHaveFocus();
    await rendered.user.tab();
    expect(choice('Cancel')).toHaveFocus();

    await rendered.user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(close).toHaveFocus();
    expect(push()).toHaveDisplayValue('On');
  });
});

describe('leaving the Settings panel with unsaved changes', () => {
  async function openSettings(options: FakeBoardOptions = {}): Promise<RenderedBoard> {
    const rendered = await renderBoard({ tasks: [one(), two()], ...options });
    await rendered.user.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('complementary', { name: 'Settings' });
    return rendered;
  }
  const settings = () => screen.getByRole('complementary', { name: 'Settings' });
  const boardPush = () =>
    within(settings()).getByRole('checkbox', { name: WORKFLOW_LABELS.push.label });

  const ways: [string, (rendered: RenderedBoard) => Promise<void>, () => boolean][] = [
    [
      'the Close button',
      ({ user }) => user.click(within(settings()).getByRole('button', { name: 'Close' })),
      () => openedPanel() === null,
    ],
    [
      'a card',
      ({ user }) => user.click(screen.getByRole('button', { name: 'Ship it' })),
      () => openedTask() === 'T1',
    ],
    [
      'another panel',
      ({ user }) => user.click(screen.getByRole('button', { name: 'Git' })),
      () => openedPanel() === 'git',
    ],
  ];

  describe.each(ways)('by %s', (_name, leave, arrived) => {
    it('asks first, and Save writes the overrides of the board and then goes', async () => {
      const rendered = await openSettings();
      await rendered.user.click(boardPush());

      await leave(rendered);
      expect(dialog()).toHaveTextContent(
        'You have unsaved changes to the AI workflow settings of the board and its columns.',
      );
      expect(arrived()).toBe(false);
      await rendered.user.click(choice('Save'));

      await waitFor(() => expect(arrived()).toBe(true));
      expect(rendered.board.workflow.board).toEqual({ push: true });
    });

    it('Save that fails: the panel stays open, and the change stays in the form (INVARIANT)', async () => {
      const rendered = await openSettings();
      rendered.board.fail(
        'updateWorkflow',
        new ApiError(422, 'UNKNOWN_STATUS', 'A status the board does not have.'),
      );
      await rendered.user.click(boardPush());
      await leave(rendered);

      await rendered.user.click(choice('Save'));

      expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
        'A status the board does not have.',
      );
      expect(arrived()).toBe(false);
      await rendered.user.click(choice('Cancel'));
      expect(boardPush()).toBeChecked();
      expect(within(settings()).getByRole('alert')).toHaveTextContent(
        'A status the board does not have.',
      );
      expect(rendered.board.workflow.board).toEqual({});
    });

    it('Discard goes without writing, and Cancel stays with the change', async () => {
      const rendered = await openSettings();
      await rendered.user.click(boardPush());
      await leave(rendered);
      await rendered.user.click(choice('Cancel'));
      expect(boardPush()).toBeChecked();
      expect(arrived()).toBe(false);

      await leave(rendered);
      await rendered.user.click(choice('Discard'));

      await waitFor(() => expect(arrived()).toBe(true));
      expect(rendered.board.calls).not.toContain('updateWorkflow');
      expect(rendered.board.workflow.board).toEqual({});
    });

    it('does not ask when nothing is unsaved', async () => {
      const rendered = await openSettings();

      await leave(rendered);

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(arrived()).toBe(true));
    });
  });

  it('does not ask again once the form has been saved with its own button', async () => {
    const rendered = await openSettings();
    await rendered.user.click(boardPush());
    await rendered.user.click(within(settings()).getByRole('button', { name: 'Save' }));
    await within(settings()).findByText('Saved.');

    await rendered.user.click(within(settings()).getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks the same three questions in the same words as a task does (INVARIANT)', async () => {
    const rendered = await openSettings();
    await rendered.user.click(boardPush());
    await rendered.user.click(within(settings()).getByRole('button', { name: 'Close' }));
    const fromSettings = within(dialog())
      .getAllByRole('button')
      .map((button) => button.textContent);
    await rendered.user.click(choice('Discard'));

    await rendered.user.click(screen.getByRole('button', { name: 'Ship it' }));
    await rendered.user.click(
      await within(await screen.findByRole('complementary', { name: 'Task T1' })).findByRole(
        'button',
        { name: 'Customize for this task' },
      ),
    );
    await rendered.user.selectOptions(push(), 'On');
    await rendered.user.click(within(details()).getByRole('button', { name: 'Close' }));

    expect(
      within(dialog())
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(fromSettings);
  });
});

describe('Discard in a form that stays on the page', () => {
  /** The block of a task with no panel around it, and a way out that leaves the block where it is. */
  function renderBlock(task: Task) {
    const board = fakeBoard({ tasks: [task] });
    const user = userEvent.setup();
    const Leave = () => {
      const leave = useLeaveGuard();
      return <button onClick={() => leave(() => undefined)}>Leave</button>;
    };
    const tree = (current: Task) => (
      <BoardProvider
        client={board.client}
        connect={(store) => {
          store.setConnection('live');
          return board.onEvent((event) => act(() => void store.handleEvent(event)));
        }}
      >
        <UnsavedChangesProvider>
          <TaskAiSettings task={current} />
          <Leave />
        </UnsavedChangesProvider>
      </BoardProvider>
    );
    const view = render(tree(task));
    return { user, board, rerender: (next: Task) => view.rerender(tree(next)) };
  }
  const settingsBlock = () => screen.getByRole('region', { name: 'AI' });
  const pushOf = () => within(settingsBlock()).getByLabelText(WORKFLOW_LABELS.push.label);

  it('puts the form back as it was: the change is gone, and there is nothing left to save', async () => {
    const { user } = renderBlock(one({ workflow: { report: false } }));
    await user.selectOptions(pushOf(), 'On');
    await user.click(screen.getByRole('button', { name: 'Leave' }));

    await user.click(choice('Discard'));

    expect(pushOf()).toHaveDisplayValue(/^Inherit/);
    expect(within(settingsBlock()).getByLabelText(WORKFLOW_LABELS.report.label)).toHaveDisplayValue(
      'Off',
    );
    expect(within(settingsBlock()).getByRole('button', { name: 'Save' })).toBeDisabled();
    // Nothing is unsaved now, so leaving again does not ask.
    await user.click(screen.getByRole('button', { name: 'Leave' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('takes what the board says now when it was changed elsewhere meanwhile, not the older version', async () => {
    const { user, rerender } = renderBlock(one({ workflow: { report: false } }));
    await user.selectOptions(pushOf(), 'On');
    rerender(one({ workflow: { report: false, checks: false } }));
    await within(settingsBlock()).findByRole('status');
    await user.click(screen.getByRole('button', { name: 'Leave' }));

    await user.click(choice('Discard'));

    expect(pushOf()).toHaveDisplayValue(/^Inherit/);
    expect(within(settingsBlock()).getByLabelText(WORKFLOW_LABELS.checks.label)).toHaveDisplayValue(
      'Off',
    );
    expect(within(settingsBlock()).queryByRole('status')).not.toBeInTheDocument();
  });
});
