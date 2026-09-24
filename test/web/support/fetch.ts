import type { FetchLike, HttpResponse, RequestInitLike } from '../../../src/web/api/http';

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** What a fake server answers: JSON, text, an error body, or a thrown network failure. */
export interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  contentType?: string;
}

export interface FakeFetch {
  fetch: FetchLike;
  calls: Recorded[];
  /** Every URL this fake was asked for, for leak assertions. */
  urls(): string[];
}

/**
 * A stand-in for the browser's fetch. The handler answers each call; throwing from it is
 * how a test says "the board is not there" — exactly what fetch does when the port is dead.
 */
export function fakeFetch(handler: (call: Recorded) => Reply | Promise<Reply>): FakeFetch {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url: string, init: RequestInitLike = {}) => {
    const call: Recorded = {
      method: init.method ?? 'GET',
      url,
      headers: { ...init.headers },
      body: init.body,
    };
    calls.push(call);
    const reply = await handler(call);
    return response(reply);
  };
  return { fetch, calls, urls: () => calls.map((call) => call.url) };
}

function response(reply: Reply): HttpResponse {
  const status = reply.status ?? 200;
  const text = reply.text ?? JSON.stringify(reply.json ?? null);
  const contentType =
    reply.contentType ?? (reply.text === undefined ? 'application/json' : 'text/markdown');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    // Like the real Response: a body that is not JSON rejects, it does not throw.
    json: async () => JSON.parse(text) as unknown,
    text: () => Promise.resolve(text),
  };
}

/** The error body every failing route of the contract answers with. */
export function errorBody(code: string, message = 'No.', details = {}): Reply['json'] {
  return { error: { code, message, details } };
}
