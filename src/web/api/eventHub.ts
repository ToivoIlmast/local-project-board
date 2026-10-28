import type { ConnectionStatus, EventSourceLike } from './events';

/**
 * One stream for all the tabs of a browser (T62, ADR-0031). A browser keeps six HTTP/1.1
 * connections per host:port and shares them between its tabs; a stream per tab used them all
 * up at the seventh tab and every other request waited for ever. So the stream lives in a
 * SharedWorker, and the tabs hear it through their ports: the connections to the board no
 * longer grow with the tabs. This file is the worker's half, and imports nothing that runs:
 * the worker carries no contract and no schema, it only relays frames.
 */

/** What a tab tells the hub. */
export type TabMessage =
  /** Count me in, and open the stream at this address if nobody has yet. */
  | { kind: 'hello'; url: string }
  /** The tab is going away (closed, or put in the back/forward cache). */
  | { kind: 'bye' };

/** What the hub tells a tab. */
export type HubMessage =
  | { kind: 'status'; status: ConnectionStatus }
  /** A frame as it came: each tab reads it against the contract itself. */
  | { kind: 'event'; data: string }
  /** The stream came back after a break; whatever happened meanwhile must be read again. */
  | { kind: 'resync' }
  /** This worker cannot open a stream; the tab opens its own. */
  | { kind: 'unsupported' };

/** The worker's end of a MessagePort, as far as the hub needs it. */
export interface HubPort {
  postMessage(message: HubMessage): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  start(): void;
}

export interface EventHubOptions {
  /** Opens the stream; missing where the worker has no EventSource. */
  create?: ((url: string) => EventSourceLike) | undefined;
}

export interface EventHub {
  /** A new tab's port, as the worker's `connect` event hands it over. */
  connect(port: HubPort): void;
  /** How many tabs are listening; for tests. */
  size(): number;
}

export function createEventHub(options: EventHubOptions): EventHub {
  const ports = new Set<HubPort>();
  let source: EventSourceLike | undefined;
  let status: ConnectionStatus = 'connecting';
  let wasLive = false;

  const broadcast = (message: HubMessage): void => {
    // A tab that died without a word has a port that swallows this; it costs nothing.
    for (const port of ports) port.postMessage(message);
  };

  const setStatus = (next: ConnectionStatus): void => {
    status = next;
    broadcast({ kind: 'status', status });
  };

  const open = (url: string, create: (url: string) => EventSourceLike): void => {
    const opened = create(url);
    source = opened;
    status = 'connecting';
    wasLive = false;
    opened.addEventListener('open', () => {
      if (source !== opened) return;
      setStatus('live');
      // Every tab resyncs at once: there is no event log on the server (§14).
      if (wasLive) broadcast({ kind: 'resync' });
      wasLive = true;
    });
    opened.addEventListener('message', (message) => {
      if (source === opened) broadcast({ kind: 'event', data: message.data });
    });
    opened.addEventListener('error', () => {
      if (source === opened) setStatus('offline');
    });
  };

  const leave = (port: HubPort): void => {
    if (!ports.delete(port) || ports.size > 0) return;
    // The last tab is gone: the connection goes with it, and the next tab opens a new one.
    source?.close();
    source = undefined;
  };

  return {
    connect(port) {
      port.addEventListener('message', ({ data }) => {
        const message = data as TabMessage | undefined;
        if (message?.kind === 'hello') {
          if (options.create === undefined) {
            port.postMessage({ kind: 'unsupported' });
            return;
          }
          ports.add(port);
          if (source === undefined) open(message.url, options.create);
          port.postMessage({ kind: 'status', status });
        } else if (message?.kind === 'bye') {
          leave(port);
        }
      });
      port.start();
    },
    size: () => ports.size,
  };
}
