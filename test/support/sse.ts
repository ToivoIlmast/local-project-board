import { request as httpRequest, type IncomingMessage } from 'node:http';
import { boardEventSchema, type BoardEvent } from '../../src/core/events.js';

export interface SseClient {
  status: number;
  headers: IncomingMessage['headers'];
  /** Every event received so far, in order. */
  events: BoardEvent[];
  /** Everything the server wrote, so comments and heartbeats can be asserted too. */
  raw(): string;
  waitFor(condition: (client: SseClient) => boolean, what?: string): Promise<void>;
  waitForEvents(count: number): Promise<BoardEvent[]>;
  close(): Promise<void>;
}

const WAIT_TIMEOUT_MS = 10_000;

/**
 * A real SSE client over a real socket: supertest buffers a response until it ends, and a
 * stream never ends, so the tests read the frames as they arrive.
 */
export function openStream(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const events: BoardEvent[] = [];
    let buffer = '';
    let received = '';
    const waiters: { check: () => boolean; done: () => void }[] = [];

    const call = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (response) => {
        const client: SseClient = {
          status: response.statusCode ?? 0,
          headers: response.headers,
          events,
          raw: () => received,
          waitFor(condition, what = 'the expected state') {
            return new Promise<void>((ok, fail) => {
              const check = (): boolean => condition(client);
              if (check()) {
                ok();
                return;
              }
              const timer = setTimeout(
                () => fail(new Error(`Timed out waiting for ${what}. Received:\n${received}`)),
                WAIT_TIMEOUT_MS,
              );
              waiters.push({
                check,
                done: () => {
                  clearTimeout(timer);
                  ok();
                },
              });
            });
          },
          async waitForEvents(count) {
            await client.waitFor((c) => c.events.length >= count, `${count} event(s)`);
            return events;
          },
          close() {
            call.destroy();
            response.destroy();
            // Give the server a turn to notice that the socket is gone.
            return new Promise((done) => setTimeout(done, 50));
          },
        };

        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          received += chunk;
          buffer += chunk;
          let split = buffer.indexOf('\n\n');
          while (split !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const data = frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice('data:'.length).trim())
              .join('\n');
            if (data !== '') events.push(boardEventSchema.parse(JSON.parse(data)));
            split = buffer.indexOf('\n\n');
          }
          for (const waiter of waiters.splice(0)) {
            if (waiter.check()) waiter.done();
            else waiters.push(waiter);
          }
        });

        resolve(client);
      },
    );
    call.on('error', reject);
    call.end();
  });
}
