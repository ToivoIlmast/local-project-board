import { boardEventSchema, type BoardEvent } from '../../contract/v1/index';

export type ConnectionStatus = 'connecting' | 'live' | 'offline';

/** One frame of the stream. */
export interface MessageLike {
  data: string;
}

/** What the page needs from EventSource; a test supplies its own, jsdom has none. */
export interface EventSourceLike {
  addEventListener(
    type: 'open' | 'message' | 'error',
    listener: (event: MessageLike) => void,
  ): void;
  close(): void;
}

export interface SubscribeOptions {
  url: string;
  onEvent: (event: BoardEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
  /**
   * The stream came back after a break. There is no event log on the server (§14), so
   * whatever happened while it was down can only be recovered by reading the board again.
   */
  onResync: () => void;
  create?: ((url: string) => EventSourceLike) | undefined;
}

/**
 * The board's live updates. The stream is the only realtime channel there is; the browser
 * reconnects by itself, and this only has to notice that it did.
 */
export function subscribeToBoard(options: SubscribeOptions): () => void {
  const create = options.create ?? ((url: string) => new EventSource(url) as EventSourceLike);
  const source = create(options.url);
  let stopped = false;
  let wasLive = false;

  options.onStatus('connecting');

  source.addEventListener('open', () => {
    if (stopped) return;
    options.onStatus('live');
    if (wasLive) options.onResync();
    wasLive = true;
  });

  source.addEventListener('message', (message) => {
    if (stopped) return;
    const event = parseEvent(message.data);
    // A frame this page cannot read is dropped: a board event it invented would be worse.
    if (event) options.onEvent(event);
  });

  source.addEventListener('error', () => {
    if (!stopped) options.onStatus('offline');
  });

  return () => {
    stopped = true;
    source.close();
  };
}

function parseEvent(data: string): BoardEvent | undefined {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return undefined;
  }
  const parsed = boardEventSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
