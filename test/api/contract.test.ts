import {
  API_BASE_PATH as API,
  routeList,
  routes,
  type Route,
  type RouteId,
} from '../../src/contract/v1/index.js';
import { handlers } from '../../src/server/http/v1/handlers.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { cleanTmpDirs } from '../support/tmp.js';

let board: TestBoard;

interface Call {
  /** Below /api/v1, with real ids in place of the example ones. */
  path: string;
  body?: unknown;
}

/** A route this sweep does not call, because it answers with a stream and not with a body. */
type NotCalled = 'streamed';

/**
 * One real request per route in the contract. The map is keyed by RouteId, so a route
 * added to the contract does not compile until this sweep calls it.
 */
const calls: Record<RouteId, Call | NotCalled> = {
  'project.get': { path: '/project' },
  'tasks.list': { path: '/tasks' },
  'tasks.create': { path: '/tasks', body: { title: 'Created by the contract test' } },
  'tasks.get': { path: '/tasks/T1' },
  'tasks.update': { path: '/tasks/T1', body: { title: 'Renamed' } },
  'tasks.move': { path: '/tasks/T1/move', body: { status: 'done' } },
  'tasks.delete': { path: '/tasks/T2' },
  'tasks.workflow': { path: '/tasks/T1/workflow' },
  'tasks.handoff': { path: '/tasks/T1/handoff' },
  'workflow.get': { path: '/workflow' },
  'workflow.update': {
    path: '/workflow',
    body: { board: { push: true }, statuses: { todo: { commit: false } } },
  },
  'documents.list': { path: '/tasks/T1/documents' },
  'documents.read': { path: '/tasks/T1/documents/plan.md' },
  'documents.write': { path: '/tasks/T1/documents/notes.md', body: { content: '# Notes\n' } },
  'documents.delete': { path: '/tasks/T1/documents/plan.md' },
  'git.status': { path: '/git/status' },
  'git.branches': { path: '/git/branches' },
  'git.commits': { path: '/git/commits?limit=5' },
  'git.diff': { path: '/git/diff' },
  'reports.list': { path: '/reports' },
  'reports.create': { path: '/reports', body: { title: 'Audit', format: 'md', content: '# A\n' } },
  'reports.read': { path: '/reports/R1' },
  'reports.delete': { path: '/reports/R1' },
  'session.get': { path: '/session' },
  'instructions.get': { path: '/instructions' },
  // A stream has no single answer to compare; test/api/sse.test.ts reads it frame by frame.
  'events.stream': 'streamed',
};

const notCalled = (kind: NotCalled): string[] =>
  Object.entries(calls)
    .filter(([, call]) => call === kind)
    .map(([id]) => id);

beforeEach(async () => {
  board = await createTestBoard();
  await board.post(`${API}/tasks`, { title: 'first' }).expect(201);
  await board.post(`${API}/tasks`, { title: 'second' }).expect(201);
  await board.put(`${API}/tasks/T1/documents/plan.md`, { content: '# Plan\n' }).expect(200);
  // An HTML report, because that is the media the contract declares for reports.read;
  // a markdown report is served as markdown, which reports.test.ts covers.
  await board
    .post(`${API}/reports`, { title: 'R', format: 'html', content: '<h1>R</h1>\n' })
    .expect(201);
});

afterEach(async () => {
  await board.close();
  await cleanTmpDirs();
});

function send(route: Route, call: Call) {
  const path = `${API}${call.path}`;
  switch (route.method) {
    case 'GET':
      return board.get(path);
    case 'POST':
      return board.post(path, call.body);
    case 'PATCH':
      return board.patch(path, call.body);
    case 'PUT':
      return board.put(path, call.body);
    case 'DELETE':
      return board.del(path);
  }
}

describe('every route in the contract', () => {
  it('is served: the only route without a handler is the stream (INVARIANT)', () => {
    expect(notCalled('streamed')).toEqual(['events.stream']);
    for (const route of routeList) {
      const served = Object.prototype.hasOwnProperty.call(handlers, route.id);
      expect([route.id, served]).toEqual([route.id, route.response.media !== 'text/event-stream']);
    }
  });

  it.each(
    Object.entries(calls)
      .filter((entry): entry is [RouteId, Call] => typeof entry[1] !== 'string')
      .map(([id, call]) => [id, call] as const),
  )('%s answers exactly what the contract declares', async (id, call) => {
    const route: Route = routes[id];

    const response = await send(route, call);

    expect(response.status).toBe(route.successStatus ?? 200);
    expect(response.headers['content-type']).toContain(route.response.media);
    const value: unknown =
      route.response.media === 'application/json' ? response.body : response.text;
    expect(() => route.response.schema.parse(value)).not.toThrow();
  });

  it('is reachable only under /api/v1', async () => {
    for (const [id, call] of Object.entries(calls)) {
      if (typeof call === 'string') continue;
      const route: Route = routes[id as RouteId];
      if (route.method !== 'GET') continue;
      await board.get(call.path).expect(404);
    }
  });
});
