import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  createDocumentService,
  createProjectService,
  createReportService,
  createTaskService,
} from '../../core/index.js';
import { assertNoOrphanedStatuses } from '../../core/rules/status.js';
import { createEventBus } from '../events/index.js';
import { gitReader } from '../git/index.js';
import { createApp } from '../http/createApp.js';
import { createSessionToken } from '../http/security.js';
import { createStorage } from '../storage/index.js';
import type { ParsedArgs } from './args.js';
import type { ResolvedBoard } from './board.js';
import { closeServer, listen } from './listen.js';
import { isBoardAlive, readRuntime, removeRuntime, writeRuntime } from './runtime.js';

// The board is a personal tool on this machine: there is no flag to listen anywhere else.
const HOST = '127.0.0.1';

export interface ServeOptions {
  board: ResolvedBoard;
  args: ParsedArgs;
  write: (line: string) => void;
  openBrowser: (url: string) => void;
}

export interface RunningBoard {
  url: string;
  port: number;
  /** Ends the run: stop listening, end open connections, forget the runtime state. */
  stop: () => Promise<void>;
}

/**
 * The composition root. Everything the board is made of is assembled here, in the order the
 * things depend on each other, and nothing is announced before it is true: the runtime state
 * is written only once the server is really listening (§13).
 */
export async function startBoard(options: ServeOptions): Promise<RunningBoard> {
  const { board, args, write, openBrowser } = options;
  const { root, config } = board;

  await refuseIfRunning(root);

  const events = createEventBus();
  // An agent that edits the files directly is a first-class way to use the board (§14).
  const storage = createStorage(config, {
    root,
    onExternalChange: () => events.publish({ type: 'board.changed' }),
  });

  try {
    await storage.init();
    // A status that tasks still use may not disappear from the config (core rule).
    assertNoOrphanedStatuses(await storage.listTasks(), config.statuses);

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

    const token = createSessionToken();
    // The Host check names the port, so the app can only be built once the port is known.
    let app: ReturnType<typeof createApp> | undefined;
    const server = createServer((request, response) => {
      if (app) app(request, response);
      else response.writeHead(503).end();
    });

    try {
      const port = await listen(server, {
        host: HOST,
        port: config.server.port,
        strictPort: args.explicitPort === true,
      });
      app = createApp({ context, token, port, webRoot: webRoot() });
      const url = `http://${HOST}:${port}/`;

      // Only now is any of this true, so only now is it written down.
      await writeRuntime({ formatVersion: 1, pid: process.pid, port, url, token, root });
      write(`local-project-board is running at ${url}`);
      if (config.server.open) openBrowser(url);

      return { url, port, stop: once(() => stop(server, storage, root)) };
    } catch (error) {
      await closeServer(server).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    await storage.close();
    throw error;
  }
}

async function stop(
  server: Parameters<typeof closeServer>[0],
  storage: { close: () => Promise<void> },
  root: string,
): Promise<void> {
  await closeServer(server);
  await storage.close();
  await removeRuntime(root);
}

/** One board per directory: a second server on the same `.board/` would fight the first. */
async function refuseIfRunning(root: string): Promise<void> {
  const runtime = await readRuntime(root);
  if (runtime.kind === 'unreadable') {
    throw new Error(
      `${runtime.file} is damaged, so the board cannot tell whether one is already running. ` +
        'Stop any running board and delete that file, then start again.',
    );
  }
  if (runtime.kind === 'missing') return;
  if (await isBoardAlive(runtime.state)) {
    throw new Error(
      `A board is already running at ${runtime.state.url} (pid ${runtime.state.pid}).`,
    );
  }
  // The board it describes is gone; its runtime state is stale and this run replaces it.
  await removeRuntime(root);
}

function once(action: () => Promise<void>): () => Promise<void> {
  let done: Promise<void> | undefined;
  return () => (done ??= action());
}

function webRoot(): string {
  return fileURLToPath(new URL('../../../web/', import.meta.url));
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
