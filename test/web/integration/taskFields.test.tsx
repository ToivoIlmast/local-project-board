import { jest } from '@jest/globals';
import { configure, screen, waitFor, within } from '@testing-library/react';
import { cleanTmpDirs } from '../../support/tmp';
import { renderAgainstRealBoard, type RealBoard } from '../support/realBoard';

/**
 * The task fields, the refusals of the real server in them, and the confirmations before a
 * manual change, against the real routes (T91; ADR-0032 §3–4, §8). The server's refusals are
 * the server's: the page only says them where they belong.
 */

const SLOW_MS = 30_000;

configure({ asyncUtilTimeout: 10_000 });

let board: RealBoard | undefined;

afterEach(async () => {
  jest.restoreAllMocks();
  board?.unmount();
  await board?.server.close().catch(() => undefined);
  board = undefined;
  await cleanTmpDirs();
});

const dialog = () => screen.getByRole('dialog');
const field = (name: string) => within(dialog()).getByLabelText(name);

/**
 * Topic P1 "Alpha" (blocks K1 Design, K2 Build) and P2 "Beta" (block K3), and the tasks
 * T1 "Dependency" (K1), T2 "Held" (K2, held by K1) and T3 "Free", the page showing them.
 */
async function withBoard(): Promise<RealBoard> {
  const started = await renderAgainstRealBoard();
  board = started;
  const { server } = started;
  await server.post('/api/v1/topics', { title: 'Alpha' }).expect(201);
  await server.post('/api/v1/topics', { title: 'Beta' }).expect(201);
  await server.post('/api/v1/topics/P1/blocks', { title: 'Design' }).expect(201);
  await server.post('/api/v1/topics/P1/blocks', { title: 'Build' }).expect(201);
  await server.post('/api/v1/topics/P2/blocks', { title: 'Prepare' }).expect(201);
  const place = (title: string, topic?: string, block?: string) => ({
    title,
    status: 'todo',
    ...(topic === undefined ? {} : { topic }),
    ...(block === undefined ? {} : { block }),
  });
  await server.post('/api/v1/tasks', place('Dependency', 'P1', 'K1')).expect(201);
  await server.post('/api/v1/tasks', place('Held', 'P1', 'K2')).expect(201);
  await server.post('/api/v1/tasks', place('Free')).expect(201);
  await screen.findByRole('button', { name: 'Free' });
  await waitFor(() => expect(screen.getByLabelText('1 blocked task')).toBeInTheDocument());
  return started;
}

async function openNew(started: RealBoard): Promise<void> {
  await started.user.click(screen.getByRole('button', { name: 'New task' }));
  await within(dialog()).findByRole('option', { name: 'P1 · Alpha' });
}

async function openEdit(started: RealBoard, id: string): Promise<void> {
  await started.user.click(screen.getByRole('button', { name: `Actions for ${id}` }));
  await started.user.click(screen.getByRole('button', { name: 'Edit' }));
}

describe('creating and editing with the fields, on a real board', () => {
  it(
    'creates a task with a Topic, a Block and dependencies: the server holds them',
    async () => {
      const { user, client } = await withBoard();
      await openNew(board!);

      await user.type(field('Title'), 'Placed');
      await user.selectOptions(field('Topic'), 'P1 · Alpha');
      await user.selectOptions(field('Block'), 'K2 · Build');
      await user.type(field('Depends on'), 'T1, T3');
      await user.click(within(dialog()).getByRole('button', { name: 'Create' }));

      await screen.findByRole('complementary', { name: /^Task T4$/ });
      expect(await client.getTask('T4')).toMatchObject({
        topic: 'P1',
        block: 'K2',
        dependsOn: ['T1', 'T3'],
      });
    },
    SLOW_MS,
  );

  it(
    'clears Topic, Block and dependencies on an edit: the server no longer has them',
    async () => {
      const { user, server, client } = await withBoard();
      await server.patch('/api/v1/tasks/T2', { dependsOn: ['T3'] }).expect(200);
      await openEdit(board!, 'T2');
      await waitFor(() => expect(field('Depends on')).toHaveValue('T3'));

      await user.selectOptions(field('Topic'), 'No topic');
      await user.clear(field('Depends on'));
      await user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));
      await user.click(within(dialog()).getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      const saved = await client.getTask('T2');
      expect(saved).not.toHaveProperty('topic');
      expect(saved).not.toHaveProperty('block');
      expect(saved).not.toHaveProperty('dependsOn');
    },
    SLOW_MS,
  );
});

describe('what the real server refuses, said at the field', () => {
  it(
    'INVALID_DEPENDENCY: a task that does not exist; nothing is created, the entry stays',
    async () => {
      const { user, client } = await withBoard();
      await openNew(board!);

      await user.type(field('Title'), 'Doomed');
      await user.type(field('Depends on'), 'T99');
      await user.click(within(dialog()).getByRole('button', { name: 'Create' }));

      const message = await within(dialog()).findByText(/T99/, { selector: '.field__error' });
      expect(field('Depends on')).toHaveAccessibleDescription(
        expect.stringContaining(message.textContent ?? ''),
      );
      expect(field('Depends on')).toBeInvalid();
      expect(field('Depends on')).toHaveValue('T99');
      expect(field('Title')).toHaveValue('Doomed');
      expect((await client.listTasks()).map((task) => task.id)).toEqual(['T1', 'T2', 'T3']);
    },
    SLOW_MS,
  );

  it(
    'DEPENDENCY_CYCLE: the tasks of the cycle are named; the edit stays in the form',
    async () => {
      const { user, server, client } = await withBoard();
      await server.patch('/api/v1/tasks/T1', { dependsOn: ['T3'] }).expect(200);
      await openEdit(board!, 'T3');

      await user.type(field('Depends on'), 'T1');
      await user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));
      await user.click(within(dialog()).getByRole('button', { name: 'Save' }));

      const message = await within(dialog()).findByText(/cycle/i, { selector: '.field__error' });
      expect(message).toHaveTextContent('T1');
      expect(field('Depends on')).toBeInvalid();
      expect(field('Depends on')).toHaveValue('T1');
      expect(await client.getTask('T3')).not.toHaveProperty('dependsOn');
    },
    SLOW_MS,
  );

  it(
    'INVALID_PLACEMENT: a block that went while the form was open; the entered values stay',
    async () => {
      const { user, server, client } = await withBoard();
      await server.post('/api/v1/topics/P2/blocks', { title: 'Extra' }).expect(201);
      await openNew(board!);
      await user.type(field('Title'), 'Doomed');
      await user.selectOptions(field('Topic'), 'P2 · Beta');
      await user.selectOptions(field('Block'), 'K4 · Extra');
      await server.del('/api/v1/topics/P2/blocks/K4').expect(200);
      await waitFor(() =>
        expect(within(field('Block')).queryByRole('option', { name: 'K4 · Extra' })).toBeNull(),
      );

      await user.click(within(dialog()).getByRole('button', { name: 'Create' }));

      const message = await within(dialog()).findByText(/K4/, { selector: '.field__error' });
      expect(field('Block')).toHaveAccessibleDescription(
        expect.stringContaining(message.textContent ?? ''),
      );
      expect(field('Block')).toBeInvalid();
      expect(field('Block')).toHaveValue('K4');
      expect(field('Topic')).toHaveValue('P2');
      expect(field('Title')).toHaveValue('Doomed');
      expect((await client.listTasks()).map((task) => task.id)).toEqual(['T1', 'T2', 'T3']);
    },
    SLOW_MS,
  );
});

describe('a move between blocks, on a real board', () => {
  async function review(started: RealBoard): Promise<void> {
    await openEdit(started, 'T2');
    await started.user.selectOptions(field('Block'), 'K1 · Design');
    await started.user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));
  }

  it(
    'cancel: not one request to change the task, and the server has the old place',
    async () => {
      const started = await withBoard();
      const update = jest.spyOn(started.client, 'updateTask');
      await review(started);
      expect(within(dialog()).getByRole('region', { name: 'Move' })).toHaveTextContent(
        'P1 · Alpha / K2 · Build',
      );

      await started.user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

      expect(update).not.toHaveBeenCalled();
      expect(await started.client.getTask('T2')).toMatchObject({ topic: 'P1', block: 'K2' });
    },
    SLOW_MS,
  );

  it(
    'confirm: exactly one request, and the page shows the answer of the server',
    async () => {
      const started = await withBoard();
      const update = jest.spyOn(started.client, 'updateTask');
      await review(started);

      await started.user.click(within(dialog()).getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0]?.[0]).toBe('T2');
      expect(update.mock.calls[0]?.[1]).toMatchObject({ block: 'K1' });
      expect(await started.client.getTask('T2')).toMatchObject({ topic: 'P1', block: 'K1' });
      // K1 is where it is now: the lock of T2 is gone with the move.
      await waitFor(() =>
        expect(screen.queryByLabelText(/blocked tasks?$/)).not.toBeInTheDocument(),
      );
    },
    SLOW_MS,
  );
});

describe('a status change of a blocked task, on a real board', () => {
  const choose = async (started: RealBoard): Promise<void> => {
    await started.user.click(screen.getByRole('button', { name: 'Actions for T2' }));
    await started.user.click(screen.getByRole('button', { name: 'Move to done' }));
  };

  it(
    'cancel: nothing is sent and the server still has the status',
    async () => {
      const started = await withBoard();
      const move = jest.spyOn(started.client, 'moveTask');
      await choose(started);
      expect(await screen.findByRole('dialog')).toHaveTextContent('block K1 is not done: T1');

      await started.user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

      expect(move).not.toHaveBeenCalled();
      expect((await started.client.getTask('T2')).status).toBe('todo');
    },
    SLOW_MS,
  );

  it(
    'confirm: one request; the owner is not stopped, and the board shows the status',
    async () => {
      const started = await withBoard();
      const move = jest.spyOn(started.client, 'moveTask');
      await choose(started);

      await started.user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Change status' }),
      );

      await waitFor(async () => expect((await started.client.getTask('T2')).status).toBe('done'));
      expect(move).toHaveBeenCalledTimes(1);
    },
    SLOW_MS,
  );
});

describe('a start the server refuses as blocked, on a real board', () => {
  it(
    'shows the reasons the server gave, not only that it refused',
    async () => {
      const { user, server } = await withBoard();
      await user.click(screen.getByRole('button', { name: 'Actions for T3' }));
      await user.click(screen.getByRole('button', { name: 'Send to AI: Claude Code' }));
      const launch = await screen.findByRole('dialog', { name: 'Start Claude Code on T3' });
      // The task becomes blocked while the dialog is open.
      await server.patch('/api/v1/tasks/T3', { dependsOn: ['T1'] }).expect(200);
      await waitFor(() => expect(screen.getByLabelText('2 blocked tasks')).toBeInTheDocument());

      await user.click(within(launch).getByRole('button', { name: 'Start' }));

      const alert = await within(launch).findByRole('alert');
      expect(alert).toHaveTextContent('T1 is not done');
    },
    SLOW_MS,
  );
});
