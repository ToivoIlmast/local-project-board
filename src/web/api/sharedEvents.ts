import type { HubMessage, TabMessage } from './eventHub';
import { parseEvent, subscribeToBoard, type SubscribeOptions } from './events';

/** The tab's end of the port to the shared worker, as far as this needs it. */
export interface TabPort {
  postMessage(message: TabMessage): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  start(): void;
  close(): void;
}

/** A connection to the hub; `onFailure` is told when the worker itself could not start. */
export interface HubConnection {
  port: TabPort;
  onFailure(listener: () => void): void;
}

/** What a page's lifecycle needs from `window`; a test supplies its own. */
export interface PageLifecycle {
  addEventListener(type: 'pagehide' | 'pageshow', listener: (event: Event) => void): void;
  removeEventListener(type: 'pagehide' | 'pageshow', listener: (event: Event) => void): void;
}

export interface SharedSubscribeOptions extends SubscribeOptions {
  /** Connects to the hub; `undefined` where there is none, and the tab opens its own stream. */
  connectHub?: (() => HubConnection | undefined) | undefined;
  page?: PageLifecycle | undefined;
}

/**
 * The board's live updates through the one stream of this browser (ADR-0031). Where there is no
 * SharedWorker, or the worker cannot open a stream, the tab falls back to a stream of its own:
 * the board still works, it only costs a connection per tab again.
 */
export function subscribeToSharedBoard(options: SharedSubscribeOptions): () => void {
  const hub = (options.connectHub ?? connectToHub)();
  if (hub === undefined) return subscribeToBoard(options);

  const { port } = hub;
  const page = options.page ?? defaultPage();
  let stopped = false;
  let own: (() => void) | undefined;

  const fallBack = (): void => {
    if (stopped || own !== undefined) return;
    port.close();
    own = subscribeToBoard(options);
  };

  port.addEventListener('message', ({ data }) => {
    if (stopped || own !== undefined) return;
    const message = data as HubMessage;
    switch (message.kind) {
      case 'status':
        options.onStatus(message.status);
        return;
      case 'event': {
        // A frame this page cannot read is dropped: a board event it invented would be worse.
        const event = parseEvent(message.data);
        if (event) options.onEvent(event);
        return;
      }
      case 'resync':
        options.onResync();
        return;
      case 'unsupported':
        fallBack();
        return;
    }
  });
  hub.onFailure(fallBack);

  const hello = (): void => port.postMessage({ kind: 'hello', url: options.url });
  const bye = (): void => port.postMessage({ kind: 'bye' });
  // A closed tab says goodbye, so the last one to go closes the stream. A tab that comes back
  // from the back/forward cache missed everything in between, and reads the board again.
  const hide = (): void => {
    if (own === undefined) bye();
  };
  const show = (event: Event): void => {
    if (own !== undefined || !(event as PageTransitionEvent).persisted) return;
    hello();
    options.onResync();
  };
  page?.addEventListener('pagehide', hide);
  page?.addEventListener('pageshow', show);

  options.onStatus('connecting');
  port.start();
  hello();

  return () => {
    stopped = true;
    page?.removeEventListener('pagehide', hide);
    page?.removeEventListener('pageshow', show);
    if (own !== undefined) {
      own();
      return;
    }
    bye();
    port.close();
  };
}

/** The board's shared worker, or nothing where the browser has none. */
function connectToHub(): HubConnection | undefined {
  if (typeof SharedWorker === 'undefined') return undefined;
  let worker: SharedWorker;
  try {
    // The literal form is what the bundler recognises and builds as a worker of its own.
    worker = new SharedWorker(new URL('./events.worker.ts', import.meta.url), {
      type: 'module',
      name: 'local-project-board events',
    });
  } catch {
    return undefined;
  }
  return {
    port: worker.port as unknown as TabPort,
    onFailure: (listener) => worker.addEventListener('error', listener),
  };
}

function defaultPage(): PageLifecycle | undefined {
  return typeof window === 'undefined' ? undefined : window;
}
