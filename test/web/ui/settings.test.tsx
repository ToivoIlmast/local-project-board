import { act, screen, waitFor, within } from '@testing-library/react';
import type { WorkflowOverrides, WorkflowState } from '../../../src/contract/v1/index';
import { WORKFLOW_KEYS } from '../../../src/core/model/workflow';
import { defaultWorkflow } from '../../../src/core/rules/workflow';
import { ApiError } from '../../../src/web/api/index';
import { WORKFLOW_LABELS } from '../../../src/web/features/settings/index';
import { renderBoard, type RenderedBoard } from '../support/render';
import { STATUSES } from '../support/fixtures';

async function openSettings(workflow?: WorkflowOverrides): Promise<RenderedBoard> {
  const rendered = await renderBoard(workflow === undefined ? {} : { workflow });
  await rendered.user.click(screen.getByRole('button', { name: 'Settings' }));
  await screen.findByRole('complementary', { name: 'Settings' });
  return rendered;
}

const panel = () => screen.getByRole('complementary', { name: 'Settings' });
const board = () => within(panel()).getByRole('group', { name: 'Board' });
const column = (status: string) => within(panel()).getByRole('group', { name: `Column ${status}` });
const save = () => within(panel()).getByRole('button', { name: 'Save' });

const stateOf = (overrides: WorkflowOverrides): WorkflowState => ({
  defaults: defaultWorkflow(STATUSES),
  ...structuredClone(overrides),
});

describe('the AI workflow settings panel', () => {
  it('opens from the header, and lives in the address like the other panels', async () => {
    const { user } = await openSettings();

    expect(new URLSearchParams(window.location.search).get('panel')).toBe('settings');
    expect(within(panel()).getByRole('heading', { name: 'Settings' })).toBeInTheDocument();

    await user.click(within(panel()).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary', { name: 'Settings' })).not.toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it('opens straight away when the page is loaded on it', async () => {
    window.history.replaceState({}, '', '/?panel=settings');
    await renderBoard();

    expect(await screen.findByRole('complementary', { name: 'Settings' })).toBeInTheDocument();
  });

  it('has one text for every setting, in one place (INVARIANT)', () => {
    for (const key of WORKFLOW_KEYS) {
      expect(WORKFLOW_LABELS[key].label).not.toBe('');
      expect(WORKFLOW_LABELS[key].description).not.toBe('');
    }
    expect(Object.keys(WORKFLOW_LABELS).sort()).toEqual([...WORKFLOW_KEYS].sort());
  });

  describe('with nothing set', () => {
    it('shows the defaults, and says that they are defaults', async () => {
      await openSettings();

      const group = board();
      for (const [key, checked] of [
        ['editCode', true],
        ['branch', true],
        ['checks', true],
        ['commit', true],
        ['push', false],
        ['report', true],
      ] as const) {
        const box = within(group).getByRole('checkbox', { name: WORKFLOW_LABELS[key].label });
        expect(box).toHaveProperty('checked', checked);
        expect(box).toHaveAccessibleDescription(/from the default/);
      }
      expect(within(group).getByLabelText(WORKFLOW_LABELS.startStatus.label)).toHaveDisplayValue(
        'Default (in-progress)',
      );
      expect(within(group).getByLabelText(WORKFLOW_LABELS.finishStatus.label)).toHaveDisplayValue(
        'Default (do not change)',
      );
      expect(within(group).getByLabelText(WORKFLOW_LABELS.baseBranch.label)).toHaveValue('');
      expect(within(group).getByLabelText(WORKFLOW_LABELS.checkCommand.label)).toHaveValue('');
    });

    it('shows every column as "as the board", with what that is now', async () => {
      await openSettings();

      for (const status of STATUSES) {
        const group = column(status);
        for (const [key, now] of [
          ['editCode', 'on'],
          ['push', 'off'],
        ] as const) {
          const select = within(group).getByLabelText(WORKFLOW_LABELS[key].label);
          expect(select).toHaveDisplayValue(`Same as the board (now ${now})`);
          expect(select).toHaveAccessibleDescription(/from the default/);
        }
      }
    });

    it('offers a column only the six on/off settings, never the board-only ones', async () => {
      await openSettings();

      const group = column('todo');
      expect(within(group).getAllByRole('combobox')).toHaveLength(6);
      for (const key of ['startStatus', 'finishStatus', 'baseBranch', 'checkCommand'] as const) {
        expect(within(group).queryByLabelText(WORKFLOW_LABELS[key].label)).not.toBeInTheDocument();
      }
    });

    it('does not offer to save what has not been changed', async () => {
      await openSettings();

      expect(save()).toBeDisabled();
    });
  });

  describe('with overrides on the board and on a column', () => {
    const stored: WorkflowOverrides = {
      board: { push: true, checkCommand: 'npm test', baseBranch: 'develop', finishStatus: 'done' },
      statuses: { backlog: { editCode: false }, todo: { push: false } },
    };

    it('shows what is stored on the board', async () => {
      await openSettings(stored);

      const group = board();
      const push = within(group).getByRole('checkbox', { name: WORKFLOW_LABELS.push.label });
      expect(push).toBeChecked();
      expect(push).toHaveAccessibleDescription(/from the board/);
      expect(within(group).getByLabelText(WORKFLOW_LABELS.checkCommand.label)).toHaveValue(
        'npm test',
      );
      expect(within(group).getByLabelText(WORKFLOW_LABELS.baseBranch.label)).toHaveValue('develop');
      expect(within(group).getByLabelText(WORKFLOW_LABELS.finishStatus.label)).toHaveDisplayValue(
        'done',
      );
    });

    it('shows, for every column, the value in effect and where it comes from', async () => {
      await openSettings(stored);

      const backlog = within(column('backlog')).getByLabelText(WORKFLOW_LABELS.editCode.label);
      expect(backlog).toHaveDisplayValue('Off');
      expect(backlog).toHaveAccessibleDescription(/In effect: off, from this column/);

      const todo = within(column('todo')).getByLabelText(WORKFLOW_LABELS.push.label);
      expect(todo).toHaveDisplayValue('Off');
      expect(todo).toHaveAccessibleDescription(/In effect: off, from this column/);

      // Not set on the column: the board's own value, and it says so.
      const done = within(column('done')).getByLabelText(WORKFLOW_LABELS.push.label);
      expect(done).toHaveDisplayValue('Same as the board (now on)');
      expect(done).toHaveAccessibleDescription(/In effect: on, from the board/);
    });
  });

  describe('editing the board', () => {
    it('saves only the settings that were changed, as overrides (INVARIANT)', async () => {
      const { user, board: fake } = await openSettings();

      await user.click(
        within(board()).getByRole('checkbox', { name: WORKFLOW_LABELS.commit.label }),
      );
      await user.click(save());

      await waitFor(() =>
        expect(fake.workflow).toEqual({ board: { commit: false }, statuses: {} }),
      );
      expect(fake.calls.filter((call) => call === 'updateWorkflow')).toHaveLength(1);
    });

    it('does not write a value that is only the default when a checkbox is put back', async () => {
      const { user } = await openSettings();
      const push = within(board()).getByRole('checkbox', { name: WORKFLOW_LABELS.push.label });

      await user.click(push);
      expect(save()).toBeEnabled();
      await user.click(push);

      // Back where it was: nothing to save.
      expect(save()).toBeDisabled();
    });

    it('sets a start status, "do not change", or the default again', async () => {
      const { user, board: fake } = await openSettings();
      const select = within(board()).getByLabelText(WORKFLOW_LABELS.startStatus.label);

      await user.selectOptions(select, 'Do not change');
      await user.click(save());
      await waitFor(() => expect(fake.workflow.board).toEqual({ startStatus: null }));

      await user.selectOptions(select, 'todo');
      await user.click(save());
      await waitFor(() => expect(fake.workflow.board).toEqual({ startStatus: 'todo' }));

      // "Default" removes the key: null and a missing key are different things.
      await user.selectOptions(select, 'Default (in-progress)');
      await user.click(save());
      await waitFor(() => expect(fake.workflow.board).toEqual({}));
    });

    it('offers the statuses of this board and nothing else', async () => {
      await openSettings();

      const select = within(board()).getByLabelText(WORKFLOW_LABELS.finishStatus.label);
      const options = within(select).getAllByRole('option');
      expect(options.map((option) => option.textContent)).toEqual([
        'Default (do not change)',
        ...STATUSES,
        'Do not change',
      ]);
    });

    it('sets the base branch and the check command, and an empty field is no override', async () => {
      const { user, board: fake } = await openSettings({
        board: { baseBranch: 'develop' },
        statuses: {},
      });

      await user.type(
        within(board()).getByLabelText(WORKFLOW_LABELS.checkCommand.label),
        'npm test',
      );
      await user.clear(within(board()).getByLabelText(WORKFLOW_LABELS.baseBranch.label));
      await user.click(save());

      await waitFor(() =>
        expect(fake.workflow).toEqual({ board: { checkCommand: 'npm test' }, statuses: {} }),
      );
    });

    it('keeps what it was not asked to change, including an explicit null', async () => {
      const { user, board: fake } = await openSettings({
        board: { finishStatus: null, startStatus: 'todo' },
        statuses: { done: { push: true } },
      });

      await user.click(
        within(board()).getByRole('checkbox', { name: WORKFLOW_LABELS.report.label }),
      );
      await user.click(save());

      await waitFor(() =>
        expect(fake.workflow).toEqual({
          board: { finishStatus: null, startStatus: 'todo', report: false },
          statuses: { done: { push: true } },
        }),
      );
    });

    it('submits from the keyboard alone', async () => {
      const { user, board: fake } = await openSettings();

      const command = within(board()).getByLabelText(WORKFLOW_LABELS.checkCommand.label);
      await user.click(command);
      await user.keyboard('npm run check{Enter}');

      await waitFor(() => expect(fake.workflow.board).toEqual({ checkCommand: 'npm run check' }));
    });
  });

  describe('editing a column', () => {
    it('sets one setting for one column and leaves the rest as the board', async () => {
      const { user, board: fake } = await openSettings();

      await user.selectOptions(
        within(column('backlog')).getByLabelText(WORKFLOW_LABELS.editCode.label),
        'Off',
      );
      await user.selectOptions(
        within(column('done')).getByLabelText(WORKFLOW_LABELS.push.label),
        'On',
      );
      await user.click(save());

      await waitFor(() =>
        expect(fake.workflow).toEqual({
          board: {},
          statuses: { backlog: { editCode: false }, done: { push: true } },
        }),
      );
    });

    it('"as the board" removes the key from the column, and an empty column with it (INVARIANT)', async () => {
      const { user, board: fake } = await openSettings({
        board: {},
        statuses: { todo: { push: true, checks: false } },
      });

      await user.selectOptions(
        within(column('todo')).getByLabelText(WORKFLOW_LABELS.push.label),
        'Same as the board (now off)',
      );
      await user.click(save());
      await waitFor(() => expect(fake.workflow.statuses).toEqual({ todo: { checks: false } }));

      await user.selectOptions(
        within(column('todo')).getByLabelText(WORKFLOW_LABELS.checks.label),
        'Same as the board (now on)',
      );
      await user.click(save());
      await waitFor(() => expect(fake.workflow.statuses).toEqual({}));
    });

    it('follows the board in the "as the board" text while the board is being edited', async () => {
      const { user } = await openSettings();

      await user.click(within(board()).getByRole('checkbox', { name: WORKFLOW_LABELS.push.label }));

      const select = within(column('todo')).getByLabelText(WORKFLOW_LABELS.push.label);
      expect(select).toHaveDisplayValue('Same as the board (now on)');
      expect(select).toHaveAccessibleDescription(/In effect: on, from the board/);
    });

    it('is reachable with the keyboard, one labelled control after the other', async () => {
      const { user } = await openSettings();

      within(column('todo')).getByLabelText(WORKFLOW_LABELS.editCode.label).focus();
      const order: (string | null)[] = [];
      for (let step = 0; step < 6; step += 1) {
        order.push(document.activeElement?.id ?? null);
        await user.tab();
      }

      const expected = ['editCode', 'branch', 'checks', 'commit', 'push', 'report'].map(
        (key) =>
          within(column('todo')).getByLabelText(
            WORKFLOW_LABELS[key as keyof typeof WORKFLOW_LABELS].label,
          ).id,
      );
      expect(order).toEqual(expected);
    });
  });

  describe('when editing code is off', () => {
    it('keeps the settings that depend on it visible and editable, muted and explained', async () => {
      const { user } = await openSettings({
        board: { editCode: false, push: true },
        statuses: {},
      });

      const push = within(board()).getByRole('checkbox', { name: WORKFLOW_LABELS.push.label });
      expect(push).toBeChecked();
      expect(push).toBeEnabled();
      expect(push).toHaveAccessibleDescription(/Not used while “Edit code” is off/);
      // Its own value is not what mutes it: "Write a report" does not need code.
      expect(
        within(board()).getByRole('checkbox', { name: WORKFLOW_LABELS.report.label }),
      ).not.toHaveAccessibleDescription(/Not used/);

      // Switching it back on restores exactly what was set.
      await user.click(
        within(board()).getByRole('checkbox', { name: WORKFLOW_LABELS.editCode.label }),
      );
      expect(push).toBeChecked();
      expect(push).not.toHaveAccessibleDescription(/Not used/);
    });

    it('is decided per column, from what the column has in effect', async () => {
      await openSettings({ board: {}, statuses: { backlog: { editCode: false } } });

      for (const key of ['branch', 'checks', 'commit', 'push'] as const) {
        expect(
          within(column('backlog')).getByLabelText(WORKFLOW_LABELS[key].label),
        ).toHaveAccessibleDescription(/Not used while “Edit code” is off/);
        expect(
          within(column('todo')).getByLabelText(WORKFLOW_LABELS[key].label),
        ).not.toHaveAccessibleDescription(/Not used/);
      }
    });

    it('is inherited by a column that does not say otherwise, and overridden by one that does', async () => {
      await openSettings({
        board: { editCode: false },
        statuses: { done: { editCode: true } },
      });

      expect(
        within(column('todo')).getByLabelText(WORKFLOW_LABELS.push.label),
      ).toHaveAccessibleDescription(/Not used/);
      expect(
        within(column('done')).getByLabelText(WORKFLOW_LABELS.push.label),
      ).not.toHaveAccessibleDescription(/Not used/);
    });
  });

  describe('a status that the board no longer has', () => {
    const stored: WorkflowOverrides = {
      board: { startStatus: 'gone', finishStatus: 'done' },
      statuses: { archive: { push: true }, todo: { commit: false } },
    };

    it('is shown as a warning, not hidden', async () => {
      await openSettings(stored);

      const alert = within(panel()).getByRole('alert');
      expect(alert).toHaveTextContent(/archive/);
      expect(alert).toHaveTextContent(/gone/);
      expect(
        within(panel()).getByRole('group', { name: 'Column archive (not a status of this board)' }),
      ).toBeInTheDocument();
      expect(within(board()).getByLabelText(WORKFLOW_LABELS.startStatus.label)).toHaveDisplayValue(
        'gone (not a status of this board)',
      );
    });

    it('can be removed by hand, and only then does the form ask to be saved', async () => {
      const { user, board: fake } = await openSettings(stored);

      expect(save()).toBeDisabled();
      await user.click(
        within(
          within(panel()).getByRole('group', {
            name: 'Column archive (not a status of this board)',
          }),
        ).getByRole('button', { name: 'Remove the settings of archive' }),
      );
      await user.selectOptions(
        within(board()).getByLabelText(WORKFLOW_LABELS.startStatus.label),
        'Default (in-progress)',
      );
      await user.click(save());

      await waitFor(() =>
        expect(fake.workflow).toEqual({
          board: { finishStatus: 'done' },
          statuses: { todo: { commit: false } },
        }),
      );
      expect(within(panel()).queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('saving', () => {
    it('shows the answer of the board when it refuses, and keeps what was typed', async () => {
      const { user, board: fake } = await openSettings();
      fake.fail(
        'updateWorkflow',
        new ApiError(
          422,
          'UNKNOWN_STATUS',
          'statuses.archive: "archive" is not a configured status.',
        ),
      );

      await user.click(within(board()).getByRole('checkbox', { name: WORKFLOW_LABELS.push.label }));
      await user.click(save());

      expect(await within(panel()).findByRole('alert')).toHaveTextContent(
        'statuses.archive: "archive" is not a configured status.',
      );
      expect(fake.workflow).toEqual({ board: {}, statuses: {} });
      expect(
        within(board()).getByRole('checkbox', { name: WORKFLOW_LABELS.push.label }),
      ).toBeChecked();
      // The person can try again.
      expect(save()).toBeEnabled();
      await user.click(save());
      await waitFor(() => expect(fake.workflow.board).toEqual({ push: true }));
      expect(within(panel()).queryByRole('alert')).not.toBeInTheDocument();
    });

    it('says it is saving, changes nothing before the board has answered, then confirms', async () => {
      const { user, board: fake } = await openSettings();
      const release = fake.hold('updateWorkflow');

      await user.click(within(board()).getByRole('checkbox', { name: WORKFLOW_LABELS.push.label }));
      await user.click(save());

      expect(within(panel()).getByRole('button', { name: 'Saving…' })).toBeDisabled();
      // No optimistic update (ADR-0025): the board has not been told yet.
      expect(fake.workflow.board).toEqual({});

      act(() => release());
      expect(await within(panel()).findByText('Saved.')).toBeInTheDocument();
      expect(fake.workflow.board).toEqual({ push: true });
      expect(save()).toBeDisabled();
    });

    it('does not treat its own save as a change made by somebody else', async () => {
      const { user } = await openSettings();

      await user.click(within(board()).getByRole('checkbox', { name: WORKFLOW_LABELS.push.label }));
      await user.click(save());
      await within(panel()).findByText('Saved.');

      expect(within(panel()).queryByText(/changed elsewhere/i)).not.toBeInTheDocument();
    });
  });

  describe('when the settings are changed outside the page', () => {
    const elsewhere: WorkflowOverrides = {
      board: { push: true, baseBranch: 'develop' },
      statuses: { todo: { editCode: false } },
    };

    it('updates a form with nothing unsaved, silently', async () => {
      const { board: fake } = await openSettings();

      act(() => fake.emit({ type: 'workflow.updated', workflow: stateOf(elsewhere) }));

      expect(
        await within(board()).findByRole('checkbox', { name: WORKFLOW_LABELS.push.label }),
      ).toBeChecked();
      expect(within(board()).getByLabelText(WORKFLOW_LABELS.baseBranch.label)).toHaveValue(
        'develop',
      );
      expect(
        within(column('todo')).getByLabelText(WORKFLOW_LABELS.editCode.label),
      ).toHaveDisplayValue('Off');
      expect(within(panel()).queryByRole('status')).not.toBeInTheDocument();
    });

    it('does not overwrite what is being typed: it says so and lets the person choose', async () => {
      const { user, board: fake } = await openSettings();
      await user.type(
        within(board()).getByLabelText(WORKFLOW_LABELS.checkCommand.label),
        'npm test',
      );

      act(() => fake.emit({ type: 'workflow.updated', workflow: stateOf(elsewhere) }));

      const notice = await within(panel()).findByRole('status');
      expect(notice).toHaveTextContent(/changed elsewhere/i);
      // The typed text is still there, and the form has not taken the other values.
      expect(within(board()).getByLabelText(WORKFLOW_LABELS.checkCommand.label)).toHaveValue(
        'npm test',
      );
      expect(within(board()).getByLabelText(WORKFLOW_LABELS.baseBranch.label)).toHaveValue('');

      await user.click(within(notice).getByRole('button', { name: 'Load the new settings' }));

      expect(within(board()).getByLabelText(WORKFLOW_LABELS.checkCommand.label)).toHaveValue('');
      expect(within(board()).getByLabelText(WORKFLOW_LABELS.baseBranch.label)).toHaveValue(
        'develop',
      );
      expect(within(panel()).queryByRole('status')).not.toBeInTheDocument();
      expect(save()).toBeDisabled();
    });

    it('is not disturbed by the board being read again with the same settings', async () => {
      const { user, store } = await openSettings();
      await user.type(
        within(board()).getByLabelText(WORKFLOW_LABELS.checkCommand.label),
        'npm test',
      );

      // Any file edited on disk makes the page read the whole board again.
      await act(() => store.handleEvent({ type: 'board.changed' }));

      expect(within(board()).getByLabelText(WORKFLOW_LABELS.checkCommand.label)).toHaveValue(
        'npm test',
      );
      expect(within(panel()).queryByRole('status')).not.toBeInTheDocument();
    });

    it('is overwritten by the person’s own save, and the notice goes away (last write wins)', async () => {
      const { user, board: fake } = await openSettings();
      await user.type(
        within(board()).getByLabelText(WORKFLOW_LABELS.checkCommand.label),
        'npm test',
      );
      act(() => fake.emit({ type: 'workflow.updated', workflow: stateOf(elsewhere) }));
      await within(panel()).findByRole('status');

      await user.click(save());

      await waitFor(() =>
        expect(fake.workflow).toEqual({ board: { checkCommand: 'npm test' }, statuses: {} }),
      );
      expect(within(panel()).queryByRole('status', { name: /changed elsewhere/i })).toBeNull();
    });
  });

  describe('what is not a setting here', () => {
    it('says where the project rules of ai.rules live, without offering to edit them', async () => {
      await openSettings();

      expect(within(panel()).getByText(/ai\.rules/)).toHaveTextContent(/board\.config\.yaml/);
      expect(within(panel()).queryByLabelText(/rules/i)).not.toBeInTheDocument();
    });
  });

  describe('for a keyboard and a screen reader', () => {
    it('gives every control a name, and groups them under a legend', async () => {
      await openSettings();

      const controls = [
        ...within(panel()).getAllByRole('checkbox'),
        ...within(panel()).getAllByRole('combobox'),
        ...within(panel()).getAllByRole('textbox'),
      ];
      expect(controls).toHaveLength(6 + 2 + 2 + STATUSES.length * 6);
      for (const control of controls) expect(control).toHaveAccessibleName();

      expect(
        within(panel())
          .getAllByRole('group')
          .map(
            (group) =>
              group.getAttribute('aria-label') ?? group.querySelector('legend')?.textContent,
          ),
      ).toEqual(['Board', ...STATUSES.map((status) => `Column ${status}`)]);
    });

    it('does not tell on and off by colour alone', async () => {
      await openSettings({ board: {}, statuses: { todo: { push: true } } });

      // The text says it; nothing here depends on how it is painted.
      expect(within(column('todo')).getByLabelText(WORKFLOW_LABELS.push.label)).toHaveDisplayValue(
        'On',
      );
    });

    it('moves focus into the panel when it is opened, and back to the button when it closes', async () => {
      const { user } = await renderBoard();
      const button = screen.getByRole('button', { name: 'Settings' });

      await user.click(button);
      expect(await screen.findByRole('complementary', { name: 'Settings' })).toHaveFocus();

      await user.click(within(panel()).getByRole('button', { name: 'Close' }));
      expect(button).toHaveFocus();
    });
  });
});
