import { screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '../../../src/web/api/index';
import { aTask } from '../support/fixtures';
import { cardsIn, renderBoard } from '../support/render';

const dialog = () => screen.getByRole('dialog');

describe('creating a task', () => {
  it('puts it on the board and opens it', async () => {
    const { user, board } = await renderBoard();

    await user.click(screen.getByRole('button', { name: 'New task' }));
    await user.type(within(dialog()).getByLabelText('Title'), 'Extract the git adapter');
    await user.type(within(dialog()).getByLabelText('Labels'), 'refactor, git');
    await user.click(within(dialog()).getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('complementary', { name: /^Task T1$/ })).toBeInTheDocument();
    expect(cardsIn('backlog')).toEqual(['T1']);
    expect(board.tasks[0]).toMatchObject({
      title: 'Extract the git adapter',
      labels: ['refactor', 'git'],
      status: 'backlog',
    });
  });

  it('starts in the column the plus was pressed in', async () => {
    const { user } = await renderBoard();

    await user.click(screen.getByRole('button', { name: 'Add a task to in-progress' }));

    expect(within(dialog()).getByLabelText('Status')).toHaveValue('in-progress');
  });

  it('will not create a task without a title', async () => {
    const { user } = await renderBoard();

    await user.click(screen.getByRole('button', { name: 'New task' }));

    expect(within(dialog()).getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('keeps the form open and says what the board said when it refuses', async () => {
    const { user, board } = await renderBoard();
    board.fail(
      'createTask',
      new ApiError(422, 'UNKNOWN_STATUS', 'Status "todo" is not on this board.'),
    );

    await user.click(screen.getByRole('button', { name: 'New task' }));
    await user.type(within(dialog()).getByLabelText('Title'), 'Doomed');
    await user.click(within(dialog()).getByRole('button', { name: 'Create' }));

    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('is not on this board');
    expect(within(dialog()).getByLabelText('Title')).toHaveValue('Doomed');
  });

  it('says it is saving while the board thinks about it', async () => {
    const { user, board } = await renderBoard();
    const release = board.hold('createTask');

    await user.click(screen.getByRole('button', { name: 'New task' }));
    await user.type(within(dialog()).getByLabelText('Title'), 'Slow');
    await user.click(within(dialog()).getByRole('button', { name: 'Create' }));

    expect(await within(dialog()).findByRole('button', { name: 'Saving…' })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('a task that is already there', () => {
  it('opens in a panel, and the address bar says which one', async () => {
    const { user } = await renderBoard({
      tasks: [aTask({ id: 'T1', title: 'Extract the git adapter', body: '## Context\n\nSoon.' })],
    });

    await user.click(screen.getByRole('button', { name: 'Extract the git adapter' }));

    const panel = await screen.findByRole('complementary', { name: 'Task T1' });
    expect(within(panel).getByRole('heading', { name: 'Extract the git adapter' })).toBeVisible();
    expect(within(panel).getByRole('heading', { name: 'Context' })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('task')).toBe('T1');

    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(new URLSearchParams(window.location.search).get('task')).toBeNull();
  });

  it('is edited through the same form', async () => {
    const { user, board } = await renderBoard({ tasks: [aTask({ id: 'T1', title: 'Old title' })] });

    await user.click(screen.getByRole('button', { name: 'Actions for T1' }));
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const title = within(dialog()).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'New title');
    await user.click(within(dialog()).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('New title')).toBeInTheDocument();
    expect(board.tasks[0]?.title).toBe('New title');
  });

  it('is deleted only after the question is answered', async () => {
    const { user, board } = await renderBoard({ tasks: [aTask({ id: 'T1', title: 'Doomed' })] });

    await user.click(screen.getByRole('button', { name: 'Actions for T1' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Doomed')).toBeInTheDocument();
    expect(board.calls).not.toContain('deleteTask');

    await user.click(screen.getByRole('button', { name: 'Actions for T1' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('Doomed')).not.toBeInTheDocument());
    expect(board.tasks).toEqual([]);
  });

  it('changes status from its panel', async () => {
    const { user, board } = await renderBoard({
      tasks: [aTask({ id: 'T1', status: 'todo', title: 'Move me' })],
    });

    await user.click(screen.getByRole('button', { name: 'Move me' }));
    const panel = await screen.findByRole('complementary', { name: 'Task T1' });
    await user.selectOptions(within(panel).getByLabelText('Status'), 'done');

    await waitFor(() => expect(cardsIn('done')).toEqual(['T1']));
    expect(board.tasks[0]?.status).toBe('done');
  });

  it('can be moved with the keyboard alone, without ever dragging (INVARIANT)', async () => {
    const { user, board } = await renderBoard({
      tasks: [
        aTask({ id: 'T1', status: 'todo', rank: 'a0' }),
        aTask({ id: 'T2', status: 'todo', rank: 'a1' }),
      ],
    });

    await user.click(screen.getByRole('button', { name: 'Actions for T2' }));
    await user.click(screen.getByRole('button', { name: 'Move up' }));
    await waitFor(() => expect(cardsIn('todo')).toEqual(['T2', 'T1']));

    await user.click(screen.getByRole('button', { name: 'Actions for T2' }));
    await user.click(screen.getByRole('button', { name: 'Move to done' }));
    await waitFor(() => expect(cardsIn('done')).toEqual(['T2']));
    expect(board.calls.filter((call) => call === 'moveTask')).toHaveLength(2);
  });

  it('does not write to the board when a move would change nothing', async () => {
    const { user, board } = await renderBoard({
      tasks: [aTask({ id: 'T1', status: 'todo', rank: 'a0' })],
    });

    await user.click(screen.getByRole('button', { name: 'Actions for T1' }));
    await user.click(screen.getByRole('button', { name: 'Move up' }));

    expect(board.calls).not.toContain('moveTask');
  });

  it('says so when the board refuses a move, and stays where it was', async () => {
    const { user, board } = await renderBoard({
      tasks: [aTask({ id: 'T1', status: 'todo' })],
    });
    board.fail(
      'moveTask',
      new ApiError(422, 'UNKNOWN_STATUS', 'Status "done" is not on this board.'),
    );

    await user.click(screen.getByRole('button', { name: 'Actions for T1' }));
    await user.click(screen.getByRole('button', { name: 'Move to done' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('is not on this board');
    expect(cardsIn('todo')).toEqual(['T1']);
  });

  it('tells the reader when the task it is showing has been deleted elsewhere', async () => {
    const { user, board } = await renderBoard({ tasks: [aTask({ id: 'T1', title: 'Going' })] });

    await user.click(screen.getByRole('button', { name: 'Going' }));
    board.emit({ type: 'task.deleted', taskId: 'T1' });

    expect(await screen.findByText(/not on the board/i)).toBeInTheDocument();
  });
});
