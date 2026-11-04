import { configure, screen, waitFor, within } from '@testing-library/react';
import { cleanTmpDirs } from '../../support/tmp';
import { renderAgainstRealBoard, type RealBoard } from '../support/realBoard';

/**
 * What the page shows of readiness on a real board (T86; ADR-0032 §7–8): a task that is blocked
 * carries 🔒, a task whose run works carries ●, and a task can carry both, because a run that has
 * started is not stopped. "Copy handoff" of a blocked task with no working run says why not.
 */

const SLOW_MS = 30_000;
const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';

configure({ asyncUtilTimeout: 10_000 });

let board: RealBoard | undefined;

afterEach(async () => {
  board?.unmount();
  await board?.server.close().catch(() => undefined);
  board = undefined;
  await cleanTmpDirs();
});

const cardOf = (title: string): HTMLElement =>
  screen.getByRole('button', { name: title }).closest('li') as HTMLElement;

/** T1 "Dependency" and T2 "Dependant", both in todo, and the page showing them. */
async function withTasks(): Promise<RealBoard> {
  const started = await renderAgainstRealBoard();
  board = started;
  for (const title of ['Dependency', 'Dependant']) {
    await started.server.post('/api/v1/tasks', { title, status: 'todo' }).expect(201);
  }
  await screen.findByRole('button', { name: 'Dependant' });
  return started;
}

const block = (server: RealBoard['server']) =>
  server.patch('/api/v1/tasks/T2', { dependsOn: ['T1'] }).expect(200);

describe('readiness on the cards of a real board', () => {
  it(
    'a run that works on a task that became blocked: the card shows ● and 🔒 together',
    async () => {
      const { server } = await withTasks();
      await server.post('/api/v1/tasks/T2/ai-run', { sessionId: SESSION, mode: 'new' }).expect(200);
      await block(server);

      await waitFor(() => expect(within(cardOf('Dependant')).getByTitle(/^Blocked/)).toBeVisible());
      const card = within(cardOf('Dependant'));
      expect(card.getByTitle(/^Blocked/)).toHaveTextContent('🔒');
      expect(card.getByTitle(/^Blocked/).getAttribute('title')).toContain('T1');
      expect(card.getByTitle('An AI run is working')).toHaveTextContent('●');
      // The dependency itself is neither.
      expect(within(cardOf('Dependency')).queryByTitle(/^Blocked/)).not.toBeInTheDocument();
      expect(within(cardOf('Dependency')).queryByTitle('An AI run is working')).toBeNull();
    },
    SLOW_MS,
  );

  it(
    'the lock goes once its cause is gone, without a reload',
    async () => {
      const { server } = await withTasks();
      await block(server);
      await waitFor(() => expect(within(cardOf('Dependant')).getByTitle(/^Blocked/)).toBeVisible());

      await server.patch('/api/v1/tasks/T1', { status: 'done' }).expect(200);

      await waitFor(() =>
        expect(within(cardOf('Dependant')).queryByTitle(/^Blocked/)).not.toBeInTheDocument(),
      );
    },
    SLOW_MS,
  );

  it(
    '"Copy handoff" of a blocked task says what the board said, and copies nothing',
    async () => {
      const { server, user } = await withTasks();
      await block(server);
      await navigator.clipboard.writeText('what was there before');

      await user.click(screen.getByRole('button', { name: 'Actions for T2' }));
      await user.click(screen.getByRole('button', { name: 'Send to AI: Copy handoff' }));

      const alert = await within(cardOf('Dependant')).findByRole('alert');
      expect(alert).toHaveTextContent(/blocked/i);
      expect(alert).toHaveTextContent('T1');
      expect(await navigator.clipboard.readText()).toBe('what was there before');
    },
    SLOW_MS,
  );
});
