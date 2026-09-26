import { jest } from '@jest/globals';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task } from '../../../src/contract/v1/index';
import { ApiError } from '../../../src/web/api/index';
import { BoardProvider } from '../../../src/web/api/react';
import { SendToAi } from '../../../src/web/features/tasks/index';
import { aTask } from '../support/fixtures';
import { fakeBoard, type FakeBoardOptions } from '../support/fakeBoard';
import { renderBoard, type RenderedBoard } from '../support/render';

const todo = (extra: Partial<Task> = {}): Task =>
  aTask({ id: 'T1', title: 'Ship it', status: 'todo', ...extra });

async function openTask(options: FakeBoardOptions = {}): Promise<RenderedBoard> {
  const rendered = await renderBoard({ tasks: [todo()], ...options });
  await rendered.user.click(screen.getByRole('button', { name: 'Ship it' }));
  await screen.findByRole('complementary', { name: 'Task T1' });
  return rendered;
}

const details = () => screen.getByRole('complementary', { name: 'Task T1' });
const sendMenu = () => within(details()).getByRole('button', { name: 'Send to AI' });

async function copyHandoff(rendered: RenderedBoard): Promise<void> {
  await rendered.user.click(sendMenu());
  await rendered.user.click(screen.getByRole('button', { name: 'Copy handoff' }));
}

describe('sending a task to an agent', () => {
  it('needs nothing but the menu for a task that has no settings of its own', async () => {
    const rendered = await openTask();

    await copyHandoff(rendered);

    expect(await within(details()).findByText('Handoff copied to the clipboard.')).toBeVisible();
    // No settings were opened, read or written on the way.
    expect(rendered.board.calls).not.toContain('taskWorkflow');
    expect(rendered.board.calls).not.toContain('updateTask');
    expect(rendered.board.calls).not.toContain('updateWorkflow');
  });

  it('copies exactly what the board gives as the handoff (INVARIANT)', async () => {
    const rendered = await openTask({
      tasks: [todo({ body: 'Do the thing.', labels: ['ai'], workflow: { push: true } })],
      documents: [{ taskId: 'T1', name: 'plan.md', content: '# Plan\n' }],
    });

    await copyHandoff(rendered);

    const expected = await rendered.board.client.handoff('T1');
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(expected));
    // It is the real text: the task, then the steps, then the API instructions.
    expect(expected).toContain('# Task T1: Ship it');
    expect(expected).toContain('`plan.md`');
  });

  it('asks the board for the handoff when it is chosen, not before, and not from a copy', async () => {
    const rendered = await openTask();
    expect(rendered.board.calls).not.toContain('handoff');

    await rendered.user.click(sendMenu());
    expect(rendered.board.calls).not.toContain('handoff');

    await rendered.user.click(screen.getByRole('button', { name: 'Copy handoff' }));
    await within(details()).findByText('Handoff copied to the clipboard.');
    expect(rendered.board.calls.filter((call) => call === 'handoff')).toHaveLength(1);
  });

  it('copies the handoff as the task is now: after the settings of the task were changed', async () => {
    const rendered = await openTask();
    await rendered.user.click(
      within(details()).getByRole('button', { name: 'Customize for this task' }),
    );
    await rendered.user.selectOptions(await within(details()).findByLabelText('Push'), 'On');
    await rendered.user.click(within(details()).getByRole('button', { name: 'Save' }));
    await within(details()).findByText('Saved.');

    await copyHandoff(rendered);

    await waitFor(async () => {
      const text = await navigator.clipboard.readText();
      expect(text).toContain('Push your commits to the remote. _(source: this task)_');
      expect(text).not.toContain('Do not push');
    });
  });

  it('copies the handoff of a task with editing code off, with the steps that follow from it', async () => {
    const rendered = await openTask({
      tasks: [todo({ workflow: { editCode: false, push: true } })],
    });

    await copyHandoff(rendered);

    await waitFor(async () => {
      const text = await navigator.clipboard.readText();
      expect(text).toContain('Do not change any file of the project: analyse and plan only.');
      // A push that was switched on does not matter without code, and the text says so.
      expect(text).toContain('Do not push: there is nothing to push.');
      expect(text).toContain('inactive: editCode is off');
    });
  });

  it('copies what the column says after the task was reset to it', async () => {
    const rendered = await openTask({
      tasks: [todo({ workflow: { push: true } })],
      workflow: { board: {}, statuses: { todo: { push: false } } },
    });
    await rendered.user.click(
      within(details()).getByRole('button', { name: 'Reset to the settings of column todo' }),
    );
    await waitFor(() => expect(rendered.board.tasks[0]).not.toHaveProperty('workflow'));

    await copyHandoff(rendered);

    await waitFor(async () => {
      const text = await navigator.clipboard.readText();
      expect(text).toContain('Do not push: nothing leaves this machine. _(source: column "todo")_');
    });
  });

  it('says what the board said when it cannot make the handoff, and copies nothing', async () => {
    const rendered = await openTask();
    await navigator.clipboard.writeText('what was there before');
    rendered.board.fail(
      'handoff',
      new ApiError(500, 'INTERNAL_ERROR', 'The handoff could not be made.'),
    );

    await copyHandoff(rendered);

    expect(await within(details()).findByRole('alert')).toHaveTextContent(
      'The handoff could not be made.',
    );
    expect(await navigator.clipboard.readText()).toBe('what was there before');
    expect(
      within(details()).queryByText('Handoff copied to the clipboard.'),
    ).not.toBeInTheDocument();
  });

  it('says so when the browser does not let the page write to the clipboard', async () => {
    const rendered = await openTask();
    const write = jest
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValueOnce(new Error('denied'));

    await copyHandoff(rendered);

    expect(await within(details()).findByRole('alert')).toHaveTextContent(
      /could not write to the clipboard/i,
    );
    expect(
      within(details()).queryByText('Handoff copied to the clipboard.'),
    ).not.toBeInTheDocument();
    write.mockRestore();
  });

  it('forgets an old answer when it is tried again', async () => {
    const rendered = await openTask();
    rendered.board.fail('handoff', new ApiError(500, 'INTERNAL_ERROR', 'Not now.'));
    await copyHandoff(rendered);
    await within(details()).findByRole('alert');

    await copyHandoff(rendered);

    expect(await within(details()).findByText('Handoff copied to the clipboard.')).toBeVisible();
    expect(within(details()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('is a menu of the keyboard: opens, is walked, chosen, and gives the focus back', async () => {
    const rendered = await openTask();

    sendMenu().focus();
    await rendered.user.keyboard('{Enter}');
    expect(sendMenu()).toHaveAttribute('aria-expanded', 'true');
    await rendered.user.tab();
    expect(screen.getByRole('button', { name: 'Copy handoff' })).toHaveFocus();
    await rendered.user.keyboard('{Enter}');

    expect(await within(details()).findByText('Handoff copied to the clipboard.')).toBeVisible();
    expect(sendMenu()).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Copy handoff' })).not.toBeInTheDocument();
  });

  it('announces the result to a screen reader without moving the focus', async () => {
    const rendered = await openTask();
    await copyHandoff(rendered);

    const done = await within(details()).findByText('Handoff copied to the clipboard.');

    expect(done.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
    expect(sendMenu()).toHaveFocus();
  });
});

describe('the menu grows without being rebuilt', () => {
  function renderMenu(targets: Parameters<typeof SendToAi>[0]['targets']) {
    const board = fakeBoard({ tasks: [todo()] });
    const user = userEvent.setup();
    render(
      <BoardProvider client={board.client} connect={() => () => undefined}>
        <SendToAi taskId="T1" targets={targets} />
      </BoardProvider>,
    );
    return { board, user };
  }

  it('has only the copy of the handoff by default: it works for any agent', async () => {
    const { user } = renderMenu(undefined);

    await user.click(screen.getByRole('button', { name: 'Send to AI' }));

    expect(screen.getAllByRole('button', { name: /handoff|Claude/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Copy handoff' })).toBeInTheDocument();
  });

  it('shows a target that another task adds, after the copy, and runs it for this task', async () => {
    const run = jest.fn<(taskId: string) => Promise<string | void>>().mockResolvedValue(undefined);
    const { user } = renderMenu([{ label: 'Claude Code', run }]);

    await user.click(screen.getByRole('button', { name: 'Send to AI' }));
    const names = within(screen.getByRole('list'))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names).toEqual(['Copy handoff', 'Claude Code']);

    await user.click(screen.getByRole('button', { name: 'Claude Code' }));

    expect(run).toHaveBeenCalledWith('T1');
  });

  it('says what went wrong when a target fails', async () => {
    const { user } = renderMenu([
      { label: 'Claude Code', run: () => Promise.reject(new Error('The agent did not start.')) },
    ]);

    await user.click(screen.getByRole('button', { name: 'Send to AI' }));
    await user.click(screen.getByRole('button', { name: 'Claude Code' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The agent did not start.');
    await act(async () => undefined);
  });
});
