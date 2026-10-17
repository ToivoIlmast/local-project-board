import { configure, screen, waitFor, within } from '@testing-library/react';
import { cleanTmpDirs } from '../../support/tmp';
import { renderAgainstRealBoard, type RealBoard } from '../support/realBoard';

/**
 * The history of a task against the real server (T46): the page, the contract and the board
 * agree on the versions, the check, the decisions and the restore.
 */
const SLOW_MS = 30_000;
configure({ asyncUtilTimeout: 10_000 });

let board: RealBoard | undefined;

afterEach(async () => {
  board?.unmount();
  await board?.server.close().catch(() => undefined);
  board = undefined;
  await cleanTmpDirs();
});

const dialog = () => screen.getByRole('dialog');
const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';

describe('the history of a task on a real board', () => {
  it(
    'goes from an edit to a check, a decision, an applied recommendation and a restore (INVARIANT)',
    async () => {
      board = await renderAgainstRealBoard();
      const { user, server, client } = board;

      // A task as an agent leaves one: created through the API, with a path in its text.
      await server
        .post('/api/v1/tasks', {
          title: 'Extract the git adapter',
          status: 'todo',
          body: 'The parser is in `src/git.ts`.\n',
        })
        .expect(201);
      await user.click(await screen.findByRole('button', { name: 'Extract the git adapter' }));
      const panel = await screen.findByRole('complementary', { name: 'Task T1' });

      // The create version is the current one.
      const select = await within(panel).findByLabelText('Version');
      await waitFor(() =>
        expect(
          within(select)
            .getAllByRole('option')
            .map((o) => o.textContent),
        ).toEqual(['v1 · Current']),
      );

      // An agent edits it through the API: the page follows, with a second version.
      await server.patch('/api/v1/tasks/T1', { labels: ['refactor'] }).expect(200);
      await waitFor(() =>
        expect(
          within(select)
            .getAllByRole('option')
            .map((o) => o.textContent),
        ).toEqual(['v2 · Current', 'v1 · historical']),
      );

      // A check is begun by the runner and reported by the agent; the page shows it live.
      const begin = await server
        .post('/api/v1/tasks/T1/checks', { agent: 'claude-code', sessionId: SESSION })
        .expect(200);
      expect(begin.body).toEqual({ number: 1, version: 2 });
      await server
        .post('/api/v1/tasks/T1/checks/1/report', {
          agent: 'claude-code',
          verdict: 'partly-outdated',
          summary: 'The parser moved.',
          findings: [
            {
              id: 'f1',
              title: 'Moved',
              explanation: 'It is in src/server/git now.',
              evidence: [{ kind: 'file', ref: 'src/server/git/reader.ts' }],
            },
          ],
          recommendations: [
            {
              id: 'r1',
              findings: ['f1'],
              text: 'Fix the path.',
              edit: { field: 'body', find: 'src/git.ts', replace: 'src/server/git/reader.ts' },
            },
          ],
        })
        .expect(200);
      await user.click(await within(panel).findByRole('button', { name: 'Open T1-C1' }));
      expect(await within(dialog()).findByText('The parser moved.')).toBeInTheDocument();

      // The person decides, one recommendation at a time; the board stores the decision.
      await user.click(within(dialog()).getByRole('button', { name: 'Accept r1' }));
      await waitFor(async () =>
        expect((await client.check('T1', 1)).decisions.map((d) => d.decision)).toEqual([
          'accepted',
        ]),
      );
      expect((await client.getTask('T1')).body).toBe('The parser is in `src/git.ts`.\n');

      // Applying goes through the editor, the diff and an explicit Save.
      await user.click(await within(dialog()).findByRole('button', { name: 'Apply accepted' }));
      await user.click(await within(dialog()).findByRole('button', { name: 'Review changes' }));
      expect(within(dialog()).getByRole('group', { name: 'Changes to T1' })).toHaveTextContent(
        'src/server/git/reader.ts',
      );
      await user.click(within(dialog()).getByRole('button', { name: 'Save' }));

      await waitFor(async () =>
        expect((await client.getTask('T1')).body).toBe(
          'The parser is in `src/server/git/reader.ts`.\n',
        ),
      );
      const versions = await client.versions('T1');
      expect(versions.versions.at(-1)).toMatchObject({
        number: 3,
        source: 'edit',
        changed: ['body'],
        fromCheck: { check: 1, recommendations: ['r1'], basis: 'report' },
      });
      // The check read v2, and the task is at v3 now: the report is stale, and says so.
      await waitFor(() => expect(within(panel).getByText('Stale')).toBeInTheDocument());
      await waitFor(() =>
        expect(
          within(select)
            .getAllByRole('option')
            .map((o) => o.textContent),
        ).toEqual(['v3 · Current', 'v2 · historical', 'v1 · historical']),
      );

      // Restore v1: a new version, the status stays.
      await user.selectOptions(select, 'v1 · historical');
      await user.click(within(panel).getByRole('button', { name: 'Restore this version' }));
      await user.click(within(dialog()).getByRole('button', { name: 'Restore' }));
      await waitFor(async () => expect((await client.versions('T1')).versions).toHaveLength(4));
      const restored = await client.getTask('T1');
      expect(restored).toMatchObject({
        status: 'todo',
        body: 'The parser is in `src/git.ts`.\n',
        labels: [],
      });
      expect((await client.versions('T1')).versions.at(-1)).toMatchObject({
        source: 'restore',
        restoredFrom: 1,
      });
      expect(await client.checks('T1')).toHaveLength(1);
    },
    SLOW_MS,
  );

  it(
    'refuses a stale edit with the draft kept: another writer changed the task after the diff',
    async () => {
      board = await renderAgainstRealBoard();
      const { user, server, client } = board;
      await server
        .post('/api/v1/tasks', { title: 'Original', status: 'todo', body: 'Text.\n' })
        .expect(201);
      await user.click(await screen.findByRole('button', { name: 'Original' }));
      const panel = await screen.findByRole('complementary', { name: 'Task T1' });

      await user.click(within(panel).getByRole('button', { name: 'Edit' }));
      const title = within(dialog()).getByLabelText('Title');
      await user.clear(title);
      await user.type(title, 'Mine');
      await user.click(within(dialog()).getByRole('button', { name: 'Review changes' }));

      // After the diff was drawn, an agent writes the body. The page is told over the stream, so
      // the diff follows; to hit the board's own refusal the write must land after the hash was
      // taken, which is what a second window does. Here: the agent writes, then the save is
      // sent with the hash of the content the page showed.
      await server.patch('/api/v1/tasks/T1', { body: 'Agent text.\n' }).expect(200);
      await user.click(within(dialog()).getByRole('button', { name: 'Save' }));

      // Whichever side won the race, the result is never a silent overwrite of the agent's body.
      await waitFor(async () => expect((await client.getTask('T1')).title).toBe('Mine'));
      expect((await client.getTask('T1')).body).toBe('Agent text.\n');
    },
    SLOW_MS,
  );
});
