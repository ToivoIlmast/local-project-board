import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createApp } from '../http/createApp.js';
import { listen } from './listen.js';
import { openBrowser } from './openBrowser.js';

const DEFAULT_PORT = 7432;
const HOST = '127.0.0.1';

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    'no-open': { type: 'boolean', default: false },
  },
  strict: true,
});

const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid --port: ${values.port}`);
  process.exit(1);
}

const webRoot = fileURLToPath(new URL('../../../web/', import.meta.url));
const server = createServer(createApp({ webRoot }));

try {
  const boundPort = await listen(server, {
    host: HOST,
    port,
    strictPort: values.port !== undefined,
  });
  const url = `http://${HOST}:${boundPort}/`;
  console.log(`local-project-board is running at ${url}`);
  if (!values['no-open']) openBrowser(url);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
