import type { EventSourceLike, MessageLike } from '../../../src/web/api/events';

export interface FakeEventSource extends EventSourceLike {
  url: string;
  closed: boolean;
  open(): void;
  message(data: string): void;
  error(): void;
}

/** A stand-in for the browser's EventSource: jsdom has none, and a test wants the frames. */
export function fakeEventSource(url: string): FakeEventSource {
  const listeners = new Map<string, ((event: MessageLike) => void)[]>();
  const emit = (type: string, event: MessageLike = { data: '' }): void => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return {
    url,
    closed: false,
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    close() {
      this.closed = true;
    },
    open: () => emit('open'),
    message: (data) => emit('message', { data }),
    error: () => emit('error'),
  };
}
