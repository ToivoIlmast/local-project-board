import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const held: Server[] = [];

/** A port something else is already listening on; it answers, but it is not a board. */
export async function occupyPort(status = 200): Promise<number> {
  const blocker = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'text/plain' }).end('not the board');
  });
  held.push(blocker);
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  return (blocker.address() as AddressInfo).port;
}

/** A port that was free a moment ago; good enough for a test that binds it at once. */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

export async function releasePorts(): Promise<void> {
  await Promise.all(
    held.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
}

/**
 * Whether *this* board — the one rooted here — is answering at that URL. Two boards for two
 * directories may share a port over time, so a test that only looked for any answer would
 * depend on what the other test workers happen to be running.
 */
export async function boardAnswersAt(url: string, root: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}api/v1/project`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    return ((await response.json()) as { root?: unknown }).root === root;
  } catch {
    return false;
  }
}
