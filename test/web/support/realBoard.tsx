import { act, render, screen, waitFor, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createBoardClient, type BoardClient, type BoardStore } from '../../../src/web/api/index';
import { subscribeToBoard } from '../../../src/web/api/events';
import { BoardProvider } from '../../../src/web/api/react';
import { BoardPage } from '../../../src/web/pages/BoardPage';
import { createTestBoard, type TestBoard } from '../../support/httpBoard';
import { nodeEventSource, nodeFetch } from './nodeTransport';

export interface RealBoard extends RenderResult {
  server: TestBoard;
  client: BoardClient;
  user: ReturnType<typeof userEvent.setup>;
}

/**
 * The page against the real server: the real router, the real contract, the real security
 * checks and the real event stream. Only the browser is a stand-in.
 */
export async function renderAgainstRealBoard(
  options: Parameters<typeof createTestBoard>[0] = {},
): Promise<RealBoard> {
  const server = await createTestBoard(options);
  const client = createBoardClient({ baseUrl: server.origin, fetch: nodeFetch });
  const user = userEvent.setup();

  const connect = (store: BoardStore): (() => void) =>
    subscribeToBoard({
      url: client.eventsUrl(),
      create: nodeEventSource,
      // Events arrive from a socket, outside React's knowledge; act() lets it catch up.
      onEvent: (event) => act(() => void store.handleEvent(event)),
      onStatus: (status) => store.setConnection(status),
      onResync: () => void store.load(),
    });

  const result = render(
    <BoardProvider client={client} connect={connect}>
      <BoardPage />
    </BoardProvider>,
  );

  await waitFor(() => expect(screen.queryByText('Loading the board…')).not.toBeInTheDocument());
  return { ...result, server, client, user };
}
