import { screen } from '@testing-library/react';
import { ApiError } from '../../../src/web/api/index';
import { renderBoard } from '../support/render';

const INSTRUCTIONS = '# local-project-board API (v1)\n\nAuthorization: Bearer secret-token\n';

describe('the instructions for an AI agent', () => {
  it('are the ones the board generates, not a copy kept in the page (INVARIANT)', async () => {
    const { user, board } = await renderBoard({ instructions: INSTRUCTIONS });

    await user.click(screen.getByRole('button', { name: 'AI instructions' }));

    expect(await screen.findByText(/Bearer secret-token/)).toBeInTheDocument();
    expect(board.calls).toContain('instructions');
  });

  it('can be copied', async () => {
    const { user } = await renderBoard({ instructions: INSTRUCTIONS });

    await user.click(screen.getByRole('button', { name: 'AI instructions' }));
    await user.click(await screen.findByRole('button', { name: 'Copy' }));

    // The clipboard here is the one user-event installs, which behaves like the browser's.
    expect(await navigator.clipboard.readText()).toBe(INSTRUCTIONS);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('say when they could not be read', async () => {
    const { user, board } = await renderBoard();
    board.fail('instructions', new ApiError(0, 'NETWORK_ERROR', 'The board is not answering.'));

    await user.click(screen.getByRole('button', { name: 'AI instructions' }));

    expect(await screen.findByText(/not answering/)).toBeInTheDocument();
  });
});
