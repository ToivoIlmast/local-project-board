import { writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Express } from 'express';
import request, { type Test } from 'supertest';
import {
  createDocumentService,
  createProjectService,
  createReportService,
  createTaskService,
} from '../../src/core/index.js';
import type { EventSink, GitReader, Storage } from '../../src/core/ports.js';
import { closeServer } from '../../src/server/cli/listen.js';
import { createEventBus, type EventBus } from '../../src/server/events/index.js';
import { nullGitReader } from '../../src/server/git/index.js';
import type { BoardContext } from '../../src/server/http/context.js';
import { createApp } from '../../src/server/http/createApp.js';
import { createSessionToken } from '../../src/server/http/security.js';
import { markdownStorage } from '../../src/server/storage/markdown/index.js';
import { recordingEventSink, type RecordingEventSink } from './events.js';
import { tmpDir } from './tmp.js';

export const STATUSES = ['backlog', 'todo', 'in-progress', 'done'];

export interface TestBoardOptions {
  root?: string;
  statuses?: string[];
  git?: GitReader;
  /** A stand-in provider, to make a failure inside the server observable over HTTP. */
  storage?: Storage;
  webRoot?: string;
  /** Watch the board directory, as the CLI does; off elsewhere so events stay predictable. */
  watch?: boolean;
  sseHeartbeatMs?: number;
}

export interface TestBoard {
  root: string;
  port: number;
  /** The board's own origin, the only one the browser may use. */
  origin: string;
  token: string;
  server: Server;
  storage: Storage;
  /** What the services published, in order. */
  events: RecordingEventSink;
  /** The same events, on their way to the open streams. */
  bus: EventBus;
  /** What the server logged instead of sending it to the client. */
  internalErrors: unknown[];
  agent(): request.Agent;
  get(path: string): Test;
  post(path: string, body?: unknown): Test;
  patch(path: string, body?: unknown): Test;
  put(path: string, body?: unknown): Test;
  del(path: string): Test;
  close(): Promise<void>;
}

/**
 * A board behind a real HTTP server on a real loopback port: the security checks name the
 * port, so they can only be tested against a server that is actually listening.
 */
export async function createTestBoard(options: TestBoardOptions = {}): Promise<TestBoard> {
  const root = options.root ?? (await tmpDir());
  const statuses = options.statuses ?? [...STATUSES];
  const events = recordingEventSink();
  const bus = createEventBus();
  // Everything the services publish is both recorded for the test and sent to the streams.
  const sink: EventSink = {
    publish: (event) => {
      events.publish(event);
      bus.publish(event);
    },
  };

  const storage =
    options.storage ??
    markdownStorage({
      root,
      ...(options.watch === true
        ? { onExternalChange: () => sink.publish({ type: 'board.changed' }) }
        : {}),
    });
  await storage.init();

  const git = options.git ?? nullGitReader();
  const context: BoardContext = {
    tasks: createTaskService({ storage, events: sink, statuses }),
    documents: createDocumentService({ storage, events: sink }),
    reports: createReportService({ storage, events: sink }),
    project: createProjectService({
      storage,
      git,
      root,
      version: '0.0.0-test',
      config: { name: 'test-board', statuses, idPrefix: 'T', provider: 'markdown' },
    }),
    git,
    events: bus,
  };

  // The app needs the bound port, so the server starts first and gets its handler after.
  // eslint-disable-next-line prefer-const -- assigned once the port is known, below.
  let app: Express | undefined;
  const server = createServer((req, res) => {
    if (app) app(req, res);
    else res.writeHead(503).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const token = createSessionToken();
  const internalErrors: unknown[] = [];
  app = createApp({
    context,
    token,
    port,
    webRoot: options.webRoot,
    ...(options.sseHeartbeatMs === undefined ? {} : { sseHeartbeatMs: options.sseHeartbeatMs }),
    onInternalError: (error) => internalErrors.push(error),
  });

  const agent = (): request.Agent => request(server);
  const authed = (test: Test): Test => test.set('Authorization', `Bearer ${token}`);
  const withBody = (test: Test, body: unknown): Test =>
    body === undefined ? test : test.send(body as object);

  return {
    root,
    port,
    origin: `http://127.0.0.1:${port}`,
    token,
    server,
    storage,
    events,
    bus,
    internalErrors,
    agent,
    get: (path) => agent().get(path),
    post: (path, body) => withBody(authed(agent().post(path)), body),
    patch: (path, body) => withBody(authed(agent().patch(path)), body),
    put: (path, body) => withBody(authed(agent().put(path)), body),
    del: (path) => authed(agent().delete(path)),
    async close() {
      await storage.close();
      // The same shutdown the CLI performs: an open stream must not hold the server open.
      await closeServer(server);
    },
  };
}

/** A stand-in for the built SPA, so the static and fallback responses can be tested. */
export async function createWebRoot(): Promise<string> {
  const dir = await tmpDir();
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head>' +
      '<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>\n',
    'utf8',
  );
  await writeFile(join(dir, 'app.js'), 'export const version = 1;\n', 'utf8');
  await writeFile(join(dir, 'app.css'), 'body { margin: 0 }\n', 'utf8');
  return dir;
}
