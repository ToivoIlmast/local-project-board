import { configure, screen, waitFor, within } from '@testing-library/react';
import { cleanTmpDirs } from '../../support/tmp';
import { renderAgainstRealBoard, type RealBoard } from '../support/realBoard';

const SLOW_MS = 30_000;

configure({ asyncUtilTimeout: 10_000 });

let board: RealBoard | undefined;

afterEach(async () => {
  board?.unmount();
  await board?.server.close().catch(() => undefined);
  board = undefined;
  await cleanTmpDirs();
});

const panel = () => screen.getByRole('complementary', { name: 'Topics' });

describe('the topics panel on a real board (T90)', () => {
  it(
    'cannot delete a topic that holds a task: the server refuses, the page says so, nothing is lost (INVARIANT)',
    async () => {
      board = await renderAgainstRealBoard();
      const { user, server } = board;
      await server.post('/api/v1/topics', { title: 'M1 Core' }).expect(201);
      await server.post('/api/v1/tasks', { title: 'Held', topic: 'P1' }).expect(201);
      await user.click(screen.getByRole('button', { name: 'Topics' }));
      await within(await screen.findByRole('complementary', { name: 'Topics' })).findByText(
        'M1 Core',
      );

      await user.click(within(panel()).getByRole('button', { name: 'Delete P1' }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));

      expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
        'not empty',
      );
      expect(await server.storage.getTopic('P1')).not.toBeNull();
      expect(within(panel()).getByText('M1 Core')).toBeInTheDocument();
      expect(server.events.types()).not.toContain('topic.deleted');
    },
    SLOW_MS,
  );

  it(
    'deletes the topic once it holds nothing, and resets a filter on it',
    async () => {
      window.history.replaceState({}, '', '/?panel=topics&topic=P1');
      board = await renderAgainstRealBoard();
      const { user, server } = board;
      await server.post('/api/v1/topics', { title: 'M1 Core' }).expect(201);
      await within(await screen.findByRole('complementary', { name: 'Topics' })).findByText(
        'M1 Core',
      );

      await user.click(within(panel()).getByRole('button', { name: 'Delete P1' }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(within(panel()).queryByText('M1 Core')).not.toBeInTheDocument());
      expect(await server.storage.getTopic('P1')).toBeNull();
      expect(new URLSearchParams(window.location.search).get('topic')).toBeNull();
    },
    SLOW_MS,
  );

  it(
    'creates and edits through the real routes, and shows a topic made elsewhere',
    async () => {
      board = await renderAgainstRealBoard();
      const { user, server } = board;
      await user.click(screen.getByRole('button', { name: 'Topics' }));
      await screen.findByRole('complementary', { name: 'Topics' });

      await user.click(within(panel()).getByRole('button', { name: 'New topic' }));
      await user.type(within(panel()).getByLabelText('Title'), 'M1 Core');
      await user.click(within(panel()).getByRole('button', { name: 'Create' }));
      await within(panel()).findByText('M1 Core');
      expect(await server.storage.getTopic('P1')).toMatchObject({ title: 'M1 Core' });

      await user.click(within(panel()).getByRole('button', { name: 'Edit P1' }));
      await user.type(within(panel()).getByLabelText('Description'), 'The goal');
      await user.click(within(panel()).getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(within(panel()).queryByLabelText('Title')).not.toBeInTheDocument(),
      );
      expect(await server.storage.getTopic('P1')).toMatchObject({ body: 'The goal' });

      await server.post('/api/v1/topics', { title: 'Made by an agent' }).expect(201);
      expect(await within(panel()).findByText('Made by an agent')).toBeInTheDocument();
    },
    SLOW_MS,
  );
});
