import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { listen } from '../../src/server/cli/listen.js';

const servers: Server[] = [];

function track(server: Server): Server {
  servers.push(server);
  return server;
}

async function occupyPort(): Promise<number> {
  const blocker = track(createServer());
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  return (blocker.address() as AddressInfo).port;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((s) => new Promise((resolve) => (s.listening ? s.close(resolve) : resolve(undefined)))),
  );
});

describe('listen', () => {
  it('binds to the loopback interface only', async () => {
    const server = track(createServer());
    await listen(server, { host: '127.0.0.1', port: 0, strictPort: true });
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('fails with a readable error when an explicitly requested port is busy', async () => {
    const busy = await occupyPort();
    const server = track(createServer());
    await expect(
      listen(server, { host: '127.0.0.1', port: busy, strictPort: true }),
    ).rejects.toThrow(`Port ${busy} is already in use.`);
  });

  it('moves to the next free port when the default port is busy', async () => {
    const busy = await occupyPort();
    const server = track(createServer());
    const bound = await listen(server, { host: '127.0.0.1', port: busy, strictPort: false });
    expect(bound).toBeGreaterThan(busy);
    expect((server.address() as AddressInfo).port).toBe(bound);
  });
});
