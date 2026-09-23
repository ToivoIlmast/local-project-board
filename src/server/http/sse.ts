import type { RequestHandler } from 'express';
import type { BoardEvent } from '../../core/events.js';

/**
 * All the stream needs from the event bus. Declared here, so the HTTP layer depends on a
 * capability and not on the adapter that happens to provide it (§20).
 */
export interface EventStream {
  subscribe(listener: (event: BoardEvent) => void): () => void;
}

/** Often enough to keep an idle connection open, rare enough to be invisible. */
export const SSE_HEARTBEAT_MS = 15_000;

/** How long the browser waits before coming back; on reconnect the UI refetches everything. */
export const SSE_RETRY_MS = 3_000;

export interface EventStreamOptions {
  heartbeatMs?: number | undefined;
}

/**
 * SSE is only a serializer: the core publishes `BoardEvent`s through a port and knows nothing
 * about streams (§14). There is no event log, so a client that arrives sees what happens next.
 */
export function createEventStreamHandler(
  stream: EventStream,
  options: EventStreamOptions = {},
): RequestHandler {
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;

  return (request, response) => {
    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
    });
    response.flushHeaders();
    response.write(`retry: ${SSE_RETRY_MS}\n\n`);

    const unsubscribe = stream.subscribe((event) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => response.write(':ping\n\n'), heartbeatMs);
    // Belt and braces: the close below clears the timer, but if a close ever went unnoticed
    // the timer must still not be the thing that keeps the process alive.
    heartbeat.unref();

    const stop = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.on('close', stop);
    response.on('close', stop);
  };
}
