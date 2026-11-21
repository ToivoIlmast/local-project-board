import { screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '../../../src/web/api/index';
import { aTask, aTopic } from '../support/fixtures';
import { cardsIn, renderBoard } from '../support/render';

/** Archive and restore on the page (T10): no optimistic change, the board answers through events. */

const STATUSES = ['backlog', 'todo', 'in-progress', 'done'] as const;
const archived = { at: '2026-09-22T10:00:00.000Z' };

afterEach(() => window.history.replaceState({}, '', '/'));

/** The card whose actions menu is open: the board header has its own Archive button. */
const cardOf = (id: string): HTMLElement =>
  screen.getByRole('button', { name: `Actions for ${id}` }).closest('li') as HTMLElement;

describe('archiving from the menu of a card', () => {
  it.each(STATUSES)('takes a task of %s off the board once the server answers', async (status) => {
    const { user, board } = await renderBoard({
      tasks: [aTask({ id: 'T1', status }), aTask({ id: 'T2', status })],
    });

    await user.click(screen.getByRole('button', { name: 'Actions for T1' }));
    await user.click(within(cardOf('T1')).getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(cardsIn(status)).toEqual(['T2']));
    expect(board.calls).toContain('archiveTask');
    expect(board.calls).not.toContain('updateTask');
  });

  it('says why the server refused, and keeps the card', async () => {
    const { user, board } = await renderBoard({ tasks: [aTask({ id: 'T1', status: 'todo' })] });
    board.fail(
      'archiveTask',
      new ApiError(409, 'AI_RUN_IN_PROGRESS', 'Task "T1" has an AI run in progress.'),
    );

    await user.click(screen.getByRole('button', { name: 'Actions for T1' }));
    await user.click(within(cardOf('T1')).getByRole('button', { name: 'Archive' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('has an AI run in progress');
    expect(cardsIn('todo')).toEqual(['T1']);
  });
});

describe('archiving and restoring from the details of a task', () => {
  it.each(STATUSES)(
    'archives a task of %s with the Archived item, not a status',
    async (status) => {
      const { user, board } = await renderBoard({
        tasks: [aTask({ id: 'T1', title: 'Mine', status })],
      });

      await user.click(screen.getByRole('button', { name: 'Mine' }));
      const select = screen.getByLabelText('Status');
      const options = within(select).getAllByRole('option');
      expect(options.slice(0, 4).map((option) => option.textContent)).toEqual([...STATUSES]);
      expect(options.at(-1)).toHaveTextContent('Archived');

      await user.selectOptions(select, 'Archived');

      await waitFor(() => expect(cardsIn(status)).toEqual([]));
      expect(board.calls).toContain('archiveTask');
      expect(board.calls).not.toContain('updateTask');
    },
  );

  it('shows the notice with the old status, locks the status, and Restore brings it back', async () => {
    const { user } = await renderBoard({
      tasks: [aTask({ id: 'T1', title: 'Mine', status: 'in-progress' })],
    });
    await user.click(screen.getByRole('button', { name: 'Mine' }));
    await user.selectOptions(screen.getByLabelText('Status'), 'Archived');

    const notice = await screen.findByText(/This task is in the archive/);
    expect(notice).toHaveTextContent('It was in in-progress');
    expect(screen.getByLabelText('Status')).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(cardsIn('in-progress')).toEqual(['T1']));
    expect(screen.queryByText(/This task is in the archive/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeEnabled();
  });

  it('says a refusal of the server and keeps the status', async () => {
    const { user, board } = await renderBoard({
      tasks: [aTask({ id: 'T1', title: 'Mine', status: 'todo' })],
    });
    board.fail('archiveTask', new ApiError(409, 'CHECK_IN_PROGRESS', 'A check has not ended.'));
    await user.click(screen.getByRole('button', { name: 'Mine' }));

    await user.selectOptions(screen.getByLabelText('Status'), 'Archived');

    expect(await screen.findByText('A check has not ended.')).toBeInTheDocument();
    expect(cardsIn('todo')).toEqual(['T1']);
    expect(screen.getByLabelText('Status')).toHaveValue('todo');
  });

  it('opens an archived task by its link with the notice, not "not on the board"', async () => {
    window.history.replaceState({}, '', '/?task=T1');
    await renderBoard({ tasks: [aTask({ id: 'T1', status: 'done', archived })] });

    expect(await screen.findByText(/This task is in the archive/)).toHaveTextContent(
      'It was in done',
    );
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.queryByText('This task is not on the board')).not.toBeInTheDocument();
    expect(cardsIn('done')).toEqual([]);
  });
});

describe('what an archived task does to the rest of the board', () => {
  it('is not a neighbour: Move up works on the visible cards', async () => {
    const { user, board } = await renderBoard({
      tasks: [
        aTask({ id: 'T1', status: 'todo', rank: 'a0' }),
        aTask({ id: 'T2', status: 'todo', rank: 'a1', archived }),
        aTask({ id: 'T3', status: 'todo', rank: 'a2' }),
      ],
    });
    expect(cardsIn('todo')).toEqual(['T1', 'T3']);

    await user.click(screen.getByRole('button', { name: 'Actions for T3' }));
    await user.click(screen.getByRole('button', { name: 'Move up' }));

    await waitFor(() => expect(cardsIn('todo')).toEqual(['T3', 'T1']));
    expect(board.calls.filter((call) => call === 'moveTask')).toHaveLength(1);
  });

  it('is not counted by the topic filter', async () => {
    window.history.replaceState({}, '', '/?topic=P1');
    await renderBoard({
      topics: [aTopic({ id: 'P1', blocks: [] })],
      tasks: [
        aTask({ id: 'T1', status: 'todo', topic: 'P1' }),
        aTask({ id: 'T2', status: 'todo', topic: 'P1', archived }),
      ],
    });

    expect(cardsIn('todo')).toEqual(['T1']);
  });

  it('leaves the Blocks view, in its block and among the unplaced', async () => {
    window.history.replaceState({}, '', '/?view=blocks');
    await renderBoard({
      topics: [aTopic({ id: 'P1', title: 'Alpha', blocks: [{ id: 'K1', title: 'Design' }] })],
      tasks: [
        aTask({ id: 'T1', title: 'Visible', topic: 'P1', block: 'K1' }),
        aTask({ id: 'T2', title: 'Hidden in block', topic: 'P1', block: 'K1', archived }),
        aTask({ id: 'T3', title: 'Hidden loose', archived }),
      ],
    });

    expect(await screen.findByText('Visible')).toBeInTheDocument();
    expect(screen.queryByText('Hidden in block')).not.toBeInTheDocument();
    expect(screen.queryByText('Hidden loose')).not.toBeInTheDocument();
    expect(screen.getByText('0/1')).toBeInTheDocument();
  });

  it('says that a task it depends on is in the archive', async () => {
    await renderBoard({
      tasks: [
        aTask({ id: 'T1', status: 'todo', archived }),
        aTask({ id: 'T2', title: 'Waiting', status: 'todo', dependsOn: ['T1'] }),
      ],
    });

    const card = screen.getByRole('button', { name: 'Waiting' }).closest('li') as HTMLElement;
    expect(card).toHaveTextContent('T1 is archived and is not done');
  });
});
