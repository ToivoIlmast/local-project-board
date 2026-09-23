import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { BoardEvent } from '../../src/core/events.js';
import { createEventBus } from '../../src/server/events/index.js';
import { createEventStreamHandler, SSE_RETRY_MS } from '../../src/server/http/sse.js';

/**
 * The serializer without a socket: what it writes, and — the part a real connection cannot
 * show — what it stops doing once the client is gone.
 */
function exchange() {
  const request = new EventEmitter() as EventEmitter & Request;
  const written: string[] = [];
  const headers: Record<string, string> = {};
  const response = Object.assign(new EventEmitter(), {
    code: 0,
    flushed: false,
    status(value: number) {
      response.code = value;
      return response;
    },
    set(values: Record<string, string>) {
      Object.assign(headers, values);
      return response;
    },
    flushHeaders() {
      response.flushed = true;
    },
    write(chunk: string) {
      written.push(chunk);
      return true;
    },
  });
  return { request, response: response as unknown as Response, written, headers, raw: response };
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const event: BoardEvent = { type: 'board.changed' };

describe('the event stream serializer', () => {
  it('opens the stream before anything has happened', () => {
    const { request, response, written, headers, raw } = exchange();

    createEventStreamHandler(createEventBus())(request, response, () => undefined);

    expect(raw.code).toBe(200);
    expect(headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    expect(raw.flushed).toBe(true);
    expect(written).toEqual([`retry: ${SSE_RETRY_MS}\n\n`]);
  });

  it('stops the heartbeat when the client goes away', async () => {
    const bus = createEventBus();
    const { request, response, written } = exchange();
    createEventStreamHandler(bus, { heartbeatMs: 10 })(request, response, () => undefined);

    await tick(60);
    expect(written.filter((chunk) => chunk.startsWith(':')).length).toBeGreaterThan(1);

    request.emit('close');
    const after = written.length;
    await tick(60);

    expect(written).toHaveLength(after);
    bus.publish(event);
    expect(written).toHaveLength(after);
    expect(bus.size).toBe(0);
  });
});
