import { act, configure, screen, waitFor, within } from '@testing-library/react';
import { cleanTmpDirs } from '../../support/tmp';
import { renderAgainstRealBoard, type RealBoard } from '../support/realBoard';

/**
 * The series of checks against the real server (T100): it comes back from the server after a
 * reload, a check made elsewhere shows up through the board's events, and a trigger the board no
 * longer holds is refused with a 400 that the panel shows.
 */
const SLOW_MS = 30_000;
configure({ asyncUtilTimeout: 10_000 });

const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';
let board: RealBoard | undefined;
let second: RealBoard | undefined;

afterEach(async () => {
  second?.unmount();
  board?.unmount();
  await board?.server.close().catch(() => undefined);
  board = undefined;
  second = undefined;
  await cleanTmpDirs();
});

const panelOf = () => screen.getByRole('region', { name: 'Series of checks' });

/** T1 done, T2 in its block: a series of one task. */
async function seed(server: RealBoard['server']): Promise<string> {
  await server.post('/api/v1/topics', { title: 'Alpha' }).expect(201);
  await server.post('/api/v1/topics/P1/blocks', { title: 'Design' }).expect(201);
  const place = { topic: 'P1', block: 'K1' };
  await server.post('/api/v1/tasks', { title: 'Source', status: 'todo', ...place }).expect(201);
  await server.post('/api/v1/tasks', { title: 'Second', status: 'todo', ...place }).expect(201);
  const done = await server.patch('/api/v1/tasks/T1', { status: 'done' }).expect(200);
  return (done.body as { doneAt: string }).doneAt;
}

async function openSource(rendered: RealBoard) {
  // The page follows the seeding through events; open the card once it has settled.
  await screen.findByRole('region', { name: /^done \(1\)/ });
  await rendered.user.click(await screen.findByRole('button', { name: 'Source' }));
  await screen.findByRole('complementary', { name: 'Task T1' });
}

describe('the series on a real board', () => {
  it(
    'comes back from the server after a reload, and follows a check made elsewhere (INVARIANT)',
    async () => {
      board = await renderAgainstRealBoard();
      const { server } = board;
      const doneAt = await seed(server);
      await openSource(board);
      await within(panelOf()).findByText('0 of 1 checked');

      // Another client: a runner begins a check of T2 for this completion, an agent reports it.
      const trigger = { reason: 'task-done', task: 'T1', doneAt };
      await server
        .post('/api/v1/tasks/T2/checks', { agent: 'claude-code', sessionId: SESSION, trigger })
        .expect(200);
      await within(panelOf()).findByText('Working');
      await server
        .post('/api/v1/tasks/T2/checks/1/report', {
          agent: 'claude-code',
          verdict: 'current',
          summary: 'Nothing moved.',
          findings: [],
          recommendations: [],
        })
        .expect(200);
      await within(panelOf()).findByText('1 of 1 checked');

      // A new page with a new store, as a reload or another tab: the same series, read again.
      board.unmount();
      second = await renderAgainstRealBoard({}, server);
      await openSource(second);
      await within(panelOf()).findByText('1 of 1 checked');
    },
    SLOW_MS,
  );

  it(
    'a trigger the board no longer holds is refused (400) and the panel says so',
    async () => {
      board = await renderAgainstRealBoard();
      const { server, store, user } = board;
      const first = await seed(server);
      await openSource(board);
      await within(panelOf()).findByText('0 of 1 checked');
      const stale = structuredClone(store.getState().tasks.find((task) => task.id === 'T1')!);
      expect(stale.doneAt).toBe(first);

      // The task is done again: a new completion, and the board holds only that one.
      await server.patch('/api/v1/tasks/T1', { status: 'todo' }).expect(200);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await server.patch('/api/v1/tasks/T1', { status: 'done' }).expect(200);
      await waitFor(() =>
        expect(store.getState().tasks.find((task) => task.id === 'T1')?.doneAt).not.toBe(first),
      );
      // The page, as if it had missed that: it holds the old completion again.
      await act(() => store.handleEvent({ type: 'task.updated', task: stale }));
      await within(panelOf()).findByText('0 of 1 checked');

      await user.click(within(panelOf()).getByRole('button', { name: 'Check T2' }));
      expect(await within(panelOf()).findByRole('alert')).toBeVisible();
    },
    SLOW_MS,
  );
});
