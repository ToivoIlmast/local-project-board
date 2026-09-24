import { act, render, screen, waitFor, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoardProvider } from '../../../src/web/api/react';
import type { BoardStore } from '../../../src/web/api/index';
import { BoardPage } from '../../../src/web/pages/BoardPage';
import { fakeBoard, type FakeBoard, type FakeBoardOptions } from './fakeBoard';

export interface RenderedBoard extends RenderResult {
  board: FakeBoard;
  user: ReturnType<typeof userEvent.setup>;
  /** The store the page is bound to, for the things only the connection can do. */
  store: BoardStore;
}

/**
 * The whole page against a board that answers like the real one, with its events delivered
 * the way the stream delivers them. Nothing here is mocked except the transport.
 */
export async function renderBoard(options: FakeBoardOptions = {}): Promise<RenderedBoard> {
  const board = fakeBoard(options);
  const user = userEvent.setup();
  let store: BoardStore | undefined;
  const connect = (bound: BoardStore): (() => void) => {
    store = bound;
    bound.setConnection('live');
    return board.onEvent((event) => act(() => void bound.handleEvent(event)));
  };

  const result = render(
    <BoardProvider client={board.client} connect={connect}>
      <BoardPage />
    </BoardProvider>,
  );

  await waitFor(() => expect(screen.queryByText('Loading the board…')).not.toBeInTheDocument());
  if (!store) throw new Error('the page never connected to the board');
  return { ...result, board, user, store };
}

/** The cards of one column, in the order the page shows them. */
export function cardsIn(status: string): string[] {
  const column = screen.getByRole('region', { name: new RegExp(`^${status}\\b`) });
  return Array.from(column.querySelectorAll('[data-task-id]')).map(
    (card) => card.getAttribute('data-task-id') ?? '',
  );
}
