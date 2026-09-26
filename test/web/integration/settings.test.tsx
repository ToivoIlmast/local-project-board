import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configure, screen, waitFor, within } from '@testing-library/react';
import { parse } from 'yaml';
import { WORKFLOW_LABELS } from '../../../src/web/features/settings/index';
import { cleanTmpDirs, tmpDir } from '../../support/tmp';
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

const panel = () => screen.getByRole('complementary', { name: 'Settings' });
const boardGroup = () => within(panel()).getByRole('group', { name: 'Board' });
const column = (status: string) => within(panel()).getByRole('group', { name: `Column ${status}` });

const workflowFile = async (root: string): Promise<unknown> =>
  parse(await readFile(join(root, '.board', 'workflow.yaml'), 'utf8'));

describe('the settings panel on a real board', () => {
  it(
    'writes overrides to .board/workflow.yaml, and a fresh page shows what was written',
    async () => {
      const root = await tmpDir();
      board = await renderAgainstRealBoard({ root });
      const { user, client } = board;

      await user.click(screen.getByRole('button', { name: 'Settings' }));
      await screen.findByRole('complementary', { name: 'Settings' });

      await user.click(
        within(boardGroup()).getByRole('checkbox', { name: WORKFLOW_LABELS.push.label }),
      );
      await user.type(
        within(boardGroup()).getByLabelText(WORKFLOW_LABELS.checkCommand.label),
        'npm test',
      );
      await user.selectOptions(
        within(boardGroup()).getByLabelText(WORKFLOW_LABELS.finishStatus.label),
        'done',
      );
      await user.selectOptions(
        within(column('backlog')).getByLabelText(WORKFLOW_LABELS.editCode.label),
        'Off',
      );
      await user.click(within(panel()).getByRole('button', { name: 'Save' }));
      await within(panel()).findByText('Saved.');

      // What the API says, and what is in the file: overrides only, no defaults, no effective values.
      const expected = {
        board: { push: true, checkCommand: 'npm test', finishStatus: 'done' },
        statuses: { backlog: { editCode: false } },
      };
      expect(await client.workflow()).toMatchObject(expected);
      expect(await workflowFile(root)).toEqual({ formatVersion: 1, ...expected });

      // A reload: another page on the same board root shows the same.
      board.unmount();
      await board.server.close();
      board = await renderAgainstRealBoard({ root });
      await board.user.click(screen.getByRole('button', { name: 'Settings' }));
      await screen.findByRole('complementary', { name: 'Settings' });

      expect(
        within(boardGroup()).getByRole('checkbox', { name: WORKFLOW_LABELS.push.label }),
      ).toBeChecked();
      expect(within(boardGroup()).getByLabelText(WORKFLOW_LABELS.checkCommand.label)).toHaveValue(
        'npm test',
      );
      expect(
        within(column('backlog')).getByLabelText(WORKFLOW_LABELS.editCode.label),
      ).toHaveDisplayValue('Off');
      expect(within(panel()).getByRole('button', { name: 'Save' })).toBeDisabled();
    },
    SLOW_MS,
  );

  it(
    'takes a change made through the API into a form that has nothing unsaved',
    async () => {
      board = await renderAgainstRealBoard();
      const { user, server } = board;
      await user.click(screen.getByRole('button', { name: 'Settings' }));
      await screen.findByRole('complementary', { name: 'Settings' });

      await server.put('/api/v1/workflow', {
        board: { baseBranch: 'develop' },
        statuses: { todo: { push: true } },
      });

      await waitFor(() =>
        expect(within(boardGroup()).getByLabelText(WORKFLOW_LABELS.baseBranch.label)).toHaveValue(
          'develop',
        ),
      );
      expect(within(column('todo')).getByLabelText(WORKFLOW_LABELS.push.label)).toHaveDisplayValue(
        'On',
      );
    },
    SLOW_MS,
  );

  it(
    'shows the refusal of the board when the file names a status the board does not have',
    async () => {
      const root = await tmpDir();
      await mkdir(join(root, '.board'), { recursive: true });
      const file = 'formatVersion: 1\nstatuses:\n  archive:\n    push: true\n';
      await writeFile(join(root, '.board', 'workflow.yaml'), file);
      board = await renderAgainstRealBoard({ root });
      const { user } = board;

      await user.click(screen.getByRole('button', { name: 'Settings' }));
      await screen.findByRole('complementary', { name: 'Settings' });
      // The stale column is shown, not hidden.
      expect(
        within(panel()).getByRole('group', { name: 'Column archive (not a status of this board)' }),
      ).toBeInTheDocument();

      // Saving anything while it is there is refused by the board, and the message is shown.
      await user.click(
        within(boardGroup()).getByRole('checkbox', { name: WORKFLOW_LABELS.push.label }),
      );
      await user.click(within(panel()).getByRole('button', { name: 'Save' }));

      expect(await within(panel()).findByText(/is not a configured status/)).toBeInTheDocument();
      expect(await readFile(join(root, '.board', 'workflow.yaml'), 'utf8')).toBe(file);
    },
    SLOW_MS,
  );
});
