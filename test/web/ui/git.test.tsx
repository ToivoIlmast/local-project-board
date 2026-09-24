import { screen, within } from '@testing-library/react';
import { ApiError } from '../../../src/web/api/index';
import { aGitStatus } from '../support/fixtures';
import { renderBoard } from '../support/render';

const commits = [
  {
    sha: '9f1c1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b',
    subject: 'Extract the git status parser',
    author: 'Toivo',
    date: '2026-09-21T11:30:00.000Z',
  },
];

describe('the git context of the board', () => {
  it('shows the branch, whether it is clean, and what changed', async () => {
    const { user } = await renderBoard({
      git: aGitStatus({
        branch: 'feat/ui',
        clean: false,
        files: [{ path: 'src/web/app/App.tsx', staged: false, status: 'modified' }],
      }),
      commits,
    });

    await user.click(screen.getByRole('button', { name: 'Git' }));

    const panel = await screen.findByRole('complementary', { name: 'Git' });
    expect(within(panel).getByText('feat/ui')).toBeInTheDocument();
    expect(within(panel).getByText('uncommitted changes')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'src/web/app/App.tsx' })).toBeInTheDocument();
    expect(await within(panel).findByText('Extract the git status parser')).toBeInTheDocument();
  });

  it('shows the diff of a file when it is asked for', async () => {
    const { user, board } = await renderBoard({
      git: aGitStatus({
        clean: false,
        files: [{ path: 'src/a.ts', staged: false, status: 'modified' }],
      }),
    });

    await user.click(screen.getByRole('button', { name: 'Git' }));
    await user.click(await screen.findByRole('button', { name: 'src/a.ts' }));

    const diff = await screen.findByRole('region', { name: 'Diff of src/a.ts' });
    expect(diff).toHaveTextContent('@@ -1 +1 @@');
    expect(board.calls).toContain('gitDiff');
  });

  it('says so when there is no git to read, and the board still works', async () => {
    const board = await renderBoard({ git: aGitStatus() });
    board.board.fail('gitStatus', new ApiError(500, 'INTERNAL_ERROR', 'git is not there'));
    await board.store.load();

    await board.user.click(screen.getByRole('button', { name: 'Git' }));

    expect(await screen.findByText('No git information')).toBeInTheDocument();
  });
});
