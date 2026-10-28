import { createEventHub, type HubPort } from './eventHub';

/**
 * The SharedWorker every tab of the board connects to: it holds the one stream of this browser
 * and relays it (ADR-0031). It lives as long as one tab of the board is open.
 */
const scope = globalThis as unknown as {
  addEventListener(type: 'connect', listener: (event: { ports: readonly HubPort[] }) => void): void;
};

const hub = createEventHub({
  create: typeof EventSource === 'undefined' ? undefined : (url) => new EventSource(url),
});

scope.addEventListener('connect', (event) => {
  const [port] = event.ports;
  if (port) hub.connect(port);
});
