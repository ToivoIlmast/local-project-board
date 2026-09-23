import type { BoardEvent } from '../../core/events.js';
import type { EventSink } from '../../core/ports.js';

export type EventListener = (event: BoardEvent) => void;

/**
 * The publish side of the `EventSink` port plus the subscribe side the transport needs.
 * In process and without a log: a client that reconnects refetches, it does not replay (§14).
 */
export interface EventBus extends EventSink {
  subscribe(listener: EventListener): () => void;
  /** How many listeners there are; one that has gone away must not stay counted. */
  readonly size: number;
}

export interface EventBusOptions {
  /** Where a listener's failure goes. A dead browser tab must not fail a write to the board. */
  onListenerError?: ((error: unknown) => void) | undefined;
}

export function createEventBus({ onListenerError }: EventBusOptions = {}): EventBus {
  const listeners = new Set<EventListener>();

  return {
    publish(event) {
      // A copy: a listener may subscribe or unsubscribe while this event is being delivered.
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          onListenerError?.(error);
        }
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    get size() {
      return listeners.size;
    },
  };
}
