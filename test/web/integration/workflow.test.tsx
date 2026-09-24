import { configure, screen, waitFor, within } from '@testing-library/react';
import { cleanTmpDirs } from '../../support/tmp';
import { cardsIn } from '../support/render';
import { renderAgainstRealBoard, type RealBoard } from '../support/realBoard';

/**
 * These tests drive a real server and a real page, keystroke by keystroke. That is well
 * within Jest's default five seconds on an idle machine and not while the other suites are
 * running beside them, so the slow ones say how long they may take.
 */
const SLOW_MS = 30_000;

// Every wait here is a wait for a real request and a real render, not for a state update.
configure({ asyncUtilTimeout: 10_000 });

let board: RealBoard | undefined;

afterEach(async () => {
  board?.unmount();
  // A test may have stopped the board itself; closing it twice is not a failure.
  await board?.server.close().catch(() => undefined);
  board = undefined;
  await cleanTmpDirs();
});

const dialog = () => screen.getByRole('dialog');

describe('a developer’s session on a real board', () => {
  it(
    'goes from an empty board through a whole task and back to the server',
    async () => {
      board = await renderAgainstRealBoard();
      const { user, server, client } = board;

      // 1. The board is read through the real API: project, tasks, reports, git.
      expect(screen.getByRole('heading', { level: 1, name: 'test-board' })).toBeInTheDocument();
      expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();

      // 2. A task is created through the UI, and the server has it.
      await user.click(screen.getByRole('button', { name: 'New task' }));
      await user.type(within(dialog()).getByLabelText('Title'), 'Extract the git adapter');
      await user.selectOptions(within(dialog()).getByLabelText('Status'), 'todo');
      await user.type(within(dialog()).getByLabelText('Labels'), 'refactor');
      await user.click(within(dialog()).getByRole('button', { name: 'Create' }));

      await screen.findByRole('complementary', { name: 'Task T1' });
      expect(await client.listTasks()).toMatchObject([
        { id: 'T1', title: 'Extract the git adapter', status: 'todo', labels: ['refactor'] },
      ]);

      // 3. It is changed through the UI, and the change is on the server.
      const panel = screen.getByRole('complementary', { name: 'Task T1' });
      await user.click(within(panel).getByRole('button', { name: 'Edit' }));
      const title = within(dialog()).getByLabelText('Title');
      await user.clear(title);
      await user.type(title, 'Extract the git reader');
      await user.click(within(dialog()).getByRole('button', { name: 'Save' }));
      await waitFor(async () =>
        expect((await client.getTask('T1')).title).toBe('Extract the git reader'),
      );

      // 4. A document is written and read back as a file on the board.
      const documents = within(panel).getByRole('region', { name: 'Documents' });
      await user.click(within(documents).getByRole('button', { name: 'New document' }));
      await user.type(within(dialog()).getByLabelText('File name'), 'plan.md');
      await user.type(within(dialog()).getByLabelText('Content'), '# Plan');
      await user.click(within(dialog()).getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('button', { name: 'plan.md' })).toBeInTheDocument();
      expect(await client.readDocument('T1', 'plan.md')).toBe('# Plan');

      // 5. The status is changed from the panel and the card is in the other column.
      await user.selectOptions(within(panel).getByLabelText('Status'), 'done');
      await waitFor(() => expect(cardsIn('done')).toEqual(['T1']));
      expect((await client.getTask('T1')).status).toBe('done');

      // 6. Another process — an agent — changes the board, and the page follows (§14).
      await server.post('/api/v1/tasks', { title: 'Written by an agent', status: 'todo' });
      expect(await screen.findByText('Written by an agent')).toBeInTheDocument();

      await server.post('/api/v1/reports', {
        title: 'Dependency audit',
        format: 'html',
        content: '<h1>Audit</h1>',
      });
      await user.click(screen.getByRole('button', { name: 'Reports' }));
      expect(await screen.findByRole('button', { name: 'Dependency audit' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Dependency audit' }));
      expect(await screen.findByTitle('Report R1')).toHaveAttribute(
        'src',
        `${server.origin}/api/v1/reports/R1`,
      );

      // 7. And the task is deleted, on the board and on the server.
      await user.click(screen.getByRole('button', { name: 'Actions for T1' }));
      await user.click(screen.getByRole('button', { name: 'Delete' }));
      await user.click(within(dialog()).getByRole('button', { name: 'Delete' }));
      await waitFor(async () => expect(await client.listTasks()).toHaveLength(1));
    },
    SLOW_MS,
  );

  it(
    'shows the cards in the order the server puts them in, move after move (INVARIANT)',
    async () => {
      board = await renderAgainstRealBoard();
      const { user, client, server } = board;
      for (const title of ['First', 'Second', 'Third']) {
        await server.post('/api/v1/tasks', { title, status: 'todo' });
      }
      await waitFor(() => expect(cardsIn('todo')).toEqual(['T1', 'T2', 'T3']));

      await user.click(screen.getByRole('button', { name: 'Actions for T3' }));
      await user.click(screen.getByRole('button', { name: 'Move up' }));
      await waitFor(() => expect(cardsIn('todo')).toEqual(['T1', 'T3', 'T2']));

      await user.click(screen.getByRole('button', { name: 'Actions for T1' }));
      await user.click(screen.getByRole('button', { name: 'Move down' }));
      await waitFor(() => expect(cardsIn('todo')).toEqual(['T3', 'T1', 'T2']));

      // The page is not guessing: this is the order the API itself answers with.
      const fromServer = (await client.listTasks())
        .filter((task) => task.status === 'todo')
        .map((task) => task.id);
      expect(cardsIn('todo')).toEqual(fromServer);
    },
    SLOW_MS,
  );

  it('keeps this run’s token out of the page (INVARIANT)', async () => {
    board = await renderAgainstRealBoard();
    const { user, server } = board;

    await user.click(screen.getByRole('button', { name: 'New task' }));
    await user.type(within(dialog()).getByLabelText('Title'), 'Something');
    await user.click(within(dialog()).getByRole('button', { name: 'Create' }));
    await screen.findByRole('complementary', { name: 'Task T1' });

    expect(document.body.innerHTML).not.toContain(server.token);
    expect(window.location.href).not.toContain(server.token);
    expect({ ...window.localStorage }).toEqual({});
    expect({ ...window.sessionStorage }).toEqual({});
  });

  it('shows the instructions the board generates, token and all', async () => {
    board = await renderAgainstRealBoard();

    await board.user.click(screen.getByRole('button', { name: 'AI instructions' }));

    const panel = await screen.findByRole('complementary', { name: 'AI instructions' });
    // The panel appears before the board has answered, so the text is what to wait for.
    // These are for an agent to take away, so here — and only here — the token is on screen.
    const token = board.server.token;
    await waitFor(() => expect(panel.textContent).toContain(token));
    expect(panel.textContent).toContain('GET /api/v1/tasks');
  });

  it('says the board is gone when it is, and does not pretend otherwise', async () => {
    board = await renderAgainstRealBoard();
    await board.server.close();

    await board.user.click(screen.getByRole('button', { name: 'Reload' }));

    expect(await screen.findByText(/not answering/i)).toBeInTheDocument();
  });
});
