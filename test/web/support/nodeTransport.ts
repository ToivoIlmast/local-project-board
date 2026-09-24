import { request as httpRequest } from 'node:http';
import type { EventSourceLike, MessageLike } from '../../../src/web/api/events';
import type { FetchLike, HttpResponse, RequestInitLike } from '../../../src/web/api/http';

/**
 * The browser's fetch, done with node:http. jsdom has no fetch, and the point of these
 * tests is that the page talks to a real board — including its Host and Origin checks.
 */
export const nodeFetch: FetchLike = (url: string, init: RequestInitLike = {}) =>
  new Promise<HttpResponse>((resolve, reject) => {
    const target = new URL(url);
    const call = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (name) => (response.headers[name.toLowerCase()] as string) ?? null },
            json: () => Promise.resolve(JSON.parse(body) as unknown),
            text: () => Promise.resolve(body),
          });
        });
      },
    );
    call.on('error', reject);
    if (init.body !== undefined) call.write(init.body);
    call.end();
  });

/** EventSource, done with node:http: the same frames, delivered the same way. */
export function nodeEventSource(url: string): EventSourceLike {
  const listeners = new Map<string, ((event: MessageLike) => void)[]>();
  const emit = (type: string, event: MessageLike = { data: '' }): void => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };

  const target = new URL(url);
  const call = httpRequest(
    {
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    },
    (response) => {
      let buffer = '';
      emit('open');
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
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
          if (data !== '') emit('message', { data });
          split = buffer.indexOf('\n\n');
        }
      });
    },
  );
  call.on('error', () => emit('error'));
  call.end();

  return {
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    close() {
      call.destroy();
    },
  };
}
