import type { Server } from 'node:http';

export interface ListenOptions {
  host: string;
  port: number;
  /** When true, a busy port is an error. When false, the next free port is tried. */
  strictPort: boolean;
  maxAttempts?: number;
}

/** Starts listening and resolves with the port actually bound. */
export async function listen(server: Server, options: ListenOptions): Promise<number> {
  const attempts = options.strictPort ? 1 : (options.maxAttempts ?? 20);
  for (let i = 0; i < attempts; i++) {
    const port = options.port + i;
    try {
      await listenOnce(server, options.host, port);
      return port;
    } catch (error) {
      const busy = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (!busy || i === attempts - 1) {
        throw busy
          ? new Error(
              options.strictPort
                ? `Port ${port} is already in use.`
                : `No free port in ${options.port}–${port}.`,
            )
          : error;
      }
    }
  }
  throw new Error('unreachable');
}

/**
 * Stops the server and ends what is still connected: an open event stream would otherwise
 * keep `close()` waiting for as long as the browser tab is open.
 */
export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function listenOnce(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}
