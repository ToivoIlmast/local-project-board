import {
  createContext,
  use,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createBoardClient, type BoardClient } from './client';
import { subscribeToBoard } from './events';
import { createBoardStore, type BoardState, type BoardStore } from './store';

/**
 * The only React in the API layer: the client, the store and the stream are plain
 * TypeScript, and this binds them to a component tree. Swapping the UI framework means
 * rewriting this file, not the layer.
 */
const BoardContext = createContext<{ client: BoardClient; store: BoardStore } | null>(null);

export interface BoardProviderProps {
  /** The board to talk to; by default the one that served this page. */
  client?: BoardClient | undefined;
  /** Starts live updates and returns the way to stop them. */
  connect?: ((store: BoardStore) => () => void) | undefined;
  children: ReactNode;
}

export function BoardProvider({ client, connect, children }: BoardProviderProps) {
  const value = useMemo(() => {
    const bound = client ?? createBoardClient();
    return { client: bound, store: createBoardStore(bound) };
  }, [client]);

  useEffect(() => {
    void value.store.load();
    if (connect) return connect(value.store);
    return subscribeToBoard({
      url: value.client.eventsUrl(),
      onEvent: (event) => void value.store.handleEvent(event),
      onStatus: (status) => value.store.setConnection(status),
      // Nothing that happened while the stream was down was delivered (§14).
      onResync: () => void value.store.load(),
    });
  }, [value, connect]);

  return <BoardContext value={value}>{children}</BoardContext>;
}

export interface Board {
  state: BoardState;
  store: BoardStore;
  client: BoardClient;
}

export function useBoard(): Board {
  const value = use(BoardContext);
  if (!value) throw new Error('This page must be rendered inside a BoardProvider.');
  const state = useSyncExternalStore(value.store.subscribe, value.store.getState);
  return { state, store: value.store, client: value.client };
}
