import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createDocumentService,
  createProjectService,
  createReportService,
  createTaskService,
} from '../../core/index.js';
import { defaultConfig } from '../config/schema.js';
import { createEventBus } from '../events/index.js';
import { gitReader } from '../git/index.js';
import { createApp } from '../http/createApp.js';
import { createSessionToken } from '../http/security.js';
import { resolveBoardRoot } from '../project/boardRoot.js';
import { createStorage } from '../storage/index.js';
import { closeServer, listen } from './listen.js';
import { openBrowser } from './openBrowser.js';

const DEFAULT_PORT = 7432;
// The board is a personal tool on this machine: there is no flag to listen anywhere else.
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

// Phase 10 completes this composition root: the config file, the orphaned-status check and
// .board/runtime.json. What is here is what the HTTP layer needs to answer at all.
const root = await resolveBoardRoot(process.cwd());
const config = defaultConfig(basename(root));
const events = createEventBus();
// An agent that edits the files directly is a first-class way to use the board (§14).
const storage = createStorage(config, {
  root,
  onExternalChange: () => events.publish({ type: 'board.changed' }),
});
await storage.init();

const git = gitReader({ root });
const context = {
  tasks: createTaskService({ storage, events, statuses: config.statuses }),
  documents: createDocumentService({ storage, events }),
  reports: createReportService({ storage, events }),
  project: createProjectService({
    storage,
    git,
    root,
    version: await readVersion(),
    config: {
      name: config.project.name,
      statuses: config.statuses,
      idPrefix: config.tasks.idPrefix,
      provider: config.storage.provider,
    },
  }),
  git,
  events,
};

const webRoot = fileURLToPath(new URL('../../../web/', import.meta.url));
// The Host check names the port, so the app can only be built once the port is known.
let app: ReturnType<typeof createApp> | undefined;
const server = createServer((request, response) => {
  if (app) app(request, response);
  else response.writeHead(503).end();
});

try {
  const boundPort = await listen(server, {
    host: HOST,
    port,
    strictPort: values.port !== undefined,
  });
  app = createApp({ context, token: createSessionToken(), port: boundPort, webRoot });
  const url = `http://${HOST}:${boundPort}/`;
  console.log(`local-project-board is running at ${url}`);
  if (!values['no-open']) openBrowser(url);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void closeServer(server)
      .then(() => storage.close())
      .then(() => process.exit(0));
  });
}

/** The published package's version; the core is told it, it never reads a file. */
async function readVersion(): Promise<string> {
  try {
    const file = fileURLToPath(new URL('../../../../package.json', import.meta.url));
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
