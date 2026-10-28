import type { HubPort } from '../../../src/web/api/eventHub';
import type { HubConnection, TabPort } from '../../../src/web/api/sharedEvents';

type Listener = (event: { data: unknown }) => void;

/** One end of a channel: what is posted on one end is heard on the other, once it is started. */
interface End {
  listeners: Listener[];
  started: boolean;
  queue: unknown[];
}

/**
 * A stand-in for a MessageChannel between a tab and the shared worker. Delivery is synchronous,
 * so a test reads what happened right after it happened; like a real port, an end holds what
 * arrives until it is started, and a closed channel carries nothing.
 */
export function portPair(): { tab: TabPort; hub: HubPort; closed: () => boolean; sent: unknown[] } {
  const tabEnd: End = { listeners: [], started: false, queue: [] };
  const hubEnd: End = { listeners: [], started: false, queue: [] };
  let closed = false;
  const sent: unknown[] = [];

  const deliver = (to: End, data: unknown): void => {
    if (closed) return;
    if (!to.started) {
      to.queue.push(data);
      return;
    }
    for (const listener of [...to.listeners]) listener({ data });
  };
  const start = (end: End): void => {
    end.started = true;
    for (const data of end.queue.splice(0)) deliver(end, data);
  };

  return {
    tab: {
      postMessage: (message) => {
        sent.push(message);
        deliver(hubEnd, message);
      },
      addEventListener: (_type, listener) => void tabEnd.listeners.push(listener),
      start: () => start(tabEnd),
      close: () => void (closed = true),
    },
    hub: {
      postMessage: (message) => deliver(tabEnd, message),
      addEventListener: (_type, listener) => void hubEnd.listeners.push(listener),
      start: () => start(hubEnd),
    },
    closed: () => closed,
    sent,
  };
}

/** A tab's connection to a hub, as `connectToHub` makes one, with a way to fail the worker. */
export function hubConnection(connect: (port: HubPort) => void): {
  connection: HubConnection;
  fail: () => void;
  closed: () => boolean;
  sent: unknown[];
} {
  const pair = portPair();
  const failures: (() => void)[] = [];
  connect(pair.hub);
  return {
    connection: { port: pair.tab, onFailure: (listener) => void failures.push(listener) },
    fail: () => failures.forEach((listener) => listener()),
    closed: pair.closed,
    sent: pair.sent,
  };
}

/** A page whose lifecycle a test drives: hide it, show it again from the back/forward cache. */
export function fakePage() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return {
    addEventListener(type: 'pagehide' | 'pageshow', listener: (event: Event) => void) {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    removeEventListener(type: 'pagehide' | 'pageshow', listener: (event: Event) => void) {
      listeners.get(type)?.delete(listener);
    },
    fire(type: 'pagehide' | 'pageshow', persisted: boolean) {
      for (const listener of listeners.get(type) ?? []) listener({ persisted } as unknown as Event);
    },
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}
