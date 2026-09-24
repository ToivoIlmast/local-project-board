import { act, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '../../../src/web/api/index';
import { BoardProvider } from '../../../src/web/api/react';
import { BoardPage } from '../../../src/web/pages/BoardPage';
import { fakeBoard } from '../support/fakeBoard';
import { aProject, aTask } from '../support/fixtures';
import { cardsIn, renderBoard } from '../support/render';

describe('the board a developer opens', () => {
  it('shows the project, its branch and its columns in the configured order', async () => {
    await renderBoard({ tasks: [aTask({ status: 'todo', title: 'Extract the git adapter' })] });

    expect(screen.getByRole('heading', { level: 1, name: /dep-health/ })).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    const columns = screen.getAllByRole('region', { name: /backlog|todo|in-progress|done/ });
    expect(columns.map((column) => column.getAttribute('aria-label'))).toEqual([
      'backlog (0)',
      'todo (1)',
      'in-progress (0)',
      'done (0)',
    ]);
    expect(screen.getByText('Extract the git adapter')).toBeInTheDocument();
  });

  it('puts every card in its column, ordered by the rank the server gave it', async () => {
    await renderBoard({
      tasks: [
        aTask({ id: 'T3', status: 'todo', rank: 'a2' }),
        aTask({ id: 'T1', status: 'done', rank: 'a0' }),
        aTask({ id: 'T2', status: 'todo', rank: 'a1' }),
      ],
    });

    expect(cardsIn('todo')).toEqual(['T2', 'T3']);
    expect(cardsIn('done')).toEqual(['T1']);
  });

  it('says the board is empty instead of showing four empty boxes', async () => {
    await renderBoard();

    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
  });

  it('says a column is empty', async () => {
    await renderBoard({ tasks: [aTask({ status: 'todo' })] });

    const done = screen.getByRole('region', { name: /^done/ });
    expect(within(done).getByText(/nothing here/i)).toBeInTheDocument();
  });

  it('says the board stopped answering without throwing away what it shows', async () => {
    const { board, user } = await renderBoard({
      tasks: [aTask({ id: 'T1', status: 'todo', title: 'Already on the board' })],
    });
    // The first load succeeded; break the next one and ask the page to read the board again.
    board.fail('project', new ApiError(0, 'NETWORK_ERROR', 'The board is not answering.'));

    await user.click(screen.getByRole('button', { name: 'Reload' }));

    expect(await screen.findByText(/not answering/)).toBeInTheDocument();
    // The board is still on screen: a failed read is not a reason for an empty page.
    expect(screen.getByRole('heading', { level: 1, name: /dep-health/ })).toBeInTheDocument();
    expect(screen.getByText('Already on the board')).toBeInTheDocument();
    expect(cardsIn('todo')).toEqual(['T1']);

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/not answering/)).not.toBeInTheDocument());
    expect(screen.getByText('Already on the board')).toBeInTheDocument();
  });

  it('shows nothing but the failure when the board has never been read', async () => {
    const board = fakeBoard();
    board.fail('project', new ApiError(0, 'NETWORK_ERROR', 'The board is not answering.'));

    render(
      <BoardProvider client={board.client} connect={() => () => undefined}>
        <BoardPage />
      </BoardProvider>,
    );

    // Nothing is known yet, so there is nothing to keep: the failure is the whole page.
    expect(await screen.findByText('The board could not be read')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('reports files it could not read as tasks instead of hiding them (ADR-0022)', async () => {
    await renderBoard({
      project: aProject({
        readIssues: [{ file: 'tasks/T7/task.md', message: 'Invalid YAML frontmatter' }],
      }),
    });

    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent('tasks/T7/task.md');
    expect(notice).toHaveTextContent('Invalid YAML frontmatter');
  });

  it('does not hide a task whose status is not on this board', async () => {
    await renderBoard({ tasks: [aTask({ id: 'T9', status: 'archived' })] });

    expect(screen.getByText(/1 task has a status this board does not have/i)).toBeInTheDocument();
  });

  it('shows a task another process created, without a reload (§14)', async () => {
    const { board } = await renderBoard();

    board.emit({ type: 'task.created', task: aTask({ id: 'T42', title: 'Written by an agent' }) });

    expect(await screen.findByText('Written by an agent')).toBeInTheDocument();
    expect(cardsIn('todo')).toEqual(['T42']);
  });

  it('removes a task another process deleted', async () => {
    const { board } = await renderBoard({ tasks: [aTask({ id: 'T1', title: 'Doomed' })] });

    board.emit({ type: 'task.deleted', taskId: 'T1' });

    await waitFor(() => expect(screen.queryByText('Doomed')).not.toBeInTheDocument());
  });

  it('reads the board again when files changed outside the server', async () => {
    const { board } = await renderBoard();
    board.tasks.push(aTask({ id: 'T5', title: 'Edited in an editor' }));

    board.emit({ type: 'board.changed' });

    expect(await screen.findByText('Edited in an editor')).toBeInTheDocument();
  });

  it('says when the live connection is gone, and stops saying it when it returns', async () => {
    const { store } = await renderBoard();

    act(() => store.setConnection('offline'));
    expect(screen.getByRole('status')).toHaveTextContent(/not answering/i);

    act(() => store.setConnection('live'));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });
});
