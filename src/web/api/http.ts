/**
 * What the page needs from the browser's fetch, and nothing more. Declaring the transport
 * structurally keeps the client testable without a server and replaceable if the board ever
 * speaks to something other than an HTTP origin (§23).
 */
export interface HttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface RequestInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: RequestInitLike) => Promise<HttpResponse>;
