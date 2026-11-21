import { screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '../../../src/web/api/index';
import { aTask, aTopic } from '../support/fixtures';
import { cardsIn, renderBoard } from '../support/render';

/** The Archive page (T11): `?view=archive`, its list, Restore, and the details of a task. */

afterEach(() => window.history.replaceState({}, '', '/'));

const at = (iso: string) => ({ at: iso });
const search = () => new URLSearchParams(window.location.search);
const page = () => screen.getByRole('region', { name: 'Archive' });
const ids = () =>
  Array.from(page().querySelectorAll('[data-task-id]')).map((el) =>
    el.getAttribute('data-task-id'),
  );

async function openArchive(options: Parameters<typeof renderBoard>[0]) {
  window.history.replaceState({}, '', '/?view=archive');
  const rendered = await renderBoard(options);
  await screen.findByRole('region', { name: 'Archive' });
  return rendered;
}

describe('opening the page', () => {
  it('is reached from the header and kept in the address', async () => {
    const { user } = await renderBoard({
      tasks: [aTask({ id: 'T1', status: 'todo', archived: at('2026-09-22T10:00:00.000Z') })],
    });
    expect(screen.queryByRole('region', { name: 'Archive' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Archive' }));

    expect(await screen.findByRole('region', { name: 'Archive' })).toBeInTheDocument();
    expect(search().get('view')).toBe('archive');
  });

  it('opens by its address and hides the topic filter', async () => {
    await openArchive({ topics: [aTopic({ id: 'P1', blocks: [] })], tasks: [] });
    expect(screen.queryByLabelText('Topic')).not.toBeInTheDocument();
  });

  it('goes back to the board with the Board button', async () => {
    const { user } = await openArchive({ tasks: [aTask({ id: 'T1', status: 'todo' })] });

    await user.click(screen.getByRole('button', { name: 'Board' }));

    await waitFor(() => expect(cardsIn('todo')).toEqual(['T1']));
    expect(search().get('view')).toBeNull();
  });
});

describe('the list', () => {
  it('shows archived tasks only, the last archived first, with what the row says', async () => {
    await openArchive({
      topics: [aTopic({ id: 'P1', title: 'Alpha', blocks: [] })],
      tasks: [
        aTask({ id: 'T1', title: 'Old', status: 'done', archived: at('2026-09-20T10:00:00.000Z') }),
        aTask({ id: 'T2', title: 'Live', status: 'todo' }),
        aTask({
          id: 'T3',
          title: 'New',
          status: 'in-progress',
          topic: 'P1',
          archived: at('2026-09-22T10:00:00.000Z'),
        }),
      ],
    });

    expect(ids()).toEqual(['T3', 'T1']);
    const row = page().querySelector('[data-task-id="T3"]') as HTMLElement;
    expect(row).toHaveTextContent('T3');
    expect(row).toHaveTextContent('New');
    expect(row).toHaveTextContent('Was in in-progress');
    expect(row).toHaveTextContent('Archived');
    expect(row).toHaveTextContent('Topic: Alpha');
  });

  it('says the archive is empty', async () => {
    await openArchive({ tasks: [aTask({ id: 'T1', status: 'todo' })] });
    expect(screen.getByText('The archive is empty')).toBeInTheDocument();
  });
});

describe('Restore', () => {
  it('takes the row off the list and puts the task in its own column', async () => {
    const { user, board } = await openArchive({
      tasks: [
        aTask({ id: 'T1', status: 'in-progress', archived: at('2026-09-22T10:00:00.000Z') }),
        aTask({ id: 'T2', status: 'done', archived: at('2026-09-21T10:00:00.000Z') }),
      ],
    });

    await user.click(screen.getByRole('button', { name: 'Restore T1' }));

    await waitFor(() => expect(ids()).toEqual(['T2']));
    expect(board.calls).toContain('restoreTask');

    await user.click(screen.getByRole('button', { name: 'Board' }));
    await waitFor(() => expect(cardsIn('in-progress')).toEqual(['T1']));
  });

  it('says a refusal (409) and keeps the row', async () => {
    const { user, board } = await openArchive({
      tasks: [aTask({ id: 'T1', status: 'todo', archived: at('2026-09-22T10:00:00.000Z') })],
    });
    board.fail('restoreTask', new ApiError(409, 'TASK_NOT_ARCHIVED', 'Task "T1" is not archived.'));

    await user.click(screen.getByRole('button', { name: 'Restore T1' }));

    expect(await within(page()).findByRole('alert')).toHaveTextContent('is not archived');
    expect(ids()).toEqual(['T1']);
  });
});

describe('details', () => {
  it('open on the right with the notice of the archive', async () => {
    const { user } = await openArchive({
      tasks: [
        aTask({
          id: 'T1',
          title: 'Mine',
          status: 'done',
          archived: at('2026-09-22T10:00:00.000Z'),
        }),
      ],
    });

    await user.click(within(page()).getByRole('button', { name: 'Mine' }));

    expect(await screen.findByText(/This task is in the archive/)).toHaveTextContent(
      'It was in done',
    );
    expect(search().get('task')).toBe('T1');
    expect(search().get('view')).toBe('archive');
  });
});
