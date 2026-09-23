import { z } from 'zod';
import {
  API_BASE_PATH as API,
  routes,
  type Route,
  type RouteId,
} from '../../src/contract/v1/index.js';
import { PENDING_ROUTE_IDS } from '../../src/server/http/v1/handlers.js';
import { createTestBoard, type TestBoard } from '../support/httpBoard.js';
import { cleanTmpDirs } from '../support/tmp.js';

let board: TestBoard;

interface Call {
  /** Below /api/v1, with real ids in place of the example ones. */
  path: string;
  body?: unknown;
}

/**
 * One real request per route in the contract. The map is keyed by RouteId, so a route
 * added to the contract does not compile until it is either served or declared pending.
 */
const calls: Record<RouteId, Call | null> = {
  'project.get': { path: '/project' },
  'tasks.list': { path: '/tasks' },
  'tasks.create': { path: '/tasks', body: { title: 'Created by the contract test' } },
  'tasks.get': { path: '/tasks/T1' },
  'tasks.update': { path: '/tasks/T1', body: { title: 'Renamed' } },
  'tasks.move': { path: '/tasks/T1/move', body: { status: 'done' } },
  'tasks.delete': { path: '/tasks/T2' },
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
  // Phase 8 serves the event stream; phase 9 serves the instructions.
  'events.stream': null,
  'instructions.get': null,
};

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
  it('is either served or declared pending, and nothing else is pending', () => {
    const pending = Object.entries(calls)
      .filter(([, call]) => call === null)
      .map(([id]) => id);
    expect(pending.sort()).toEqual([...PENDING_ROUTE_IDS].sort());
  });

  it.each(
    Object.entries(calls)
      .filter((entry): entry is [RouteId, Call] => entry[1] !== null)
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
      if (call === null) continue;
      const route: Route = routes[id as RouteId];
      if (route.method !== 'GET') continue;
      await board.get(call.path).expect(404);
    }
  });
});

describe('the pending routes', () => {
  it('are not served yet and are hidden from the AI instructions', async () => {
    for (const id of PENDING_ROUTE_IDS) {
      expect(routes[id].ai.include).toBe(false);
      const response = await board.get(`${API}${routes[id].path}`);
      expect(response.status).toBe(404);
    }
    expect(z.array(z.string()).parse([...PENDING_ROUTE_IDS])).toEqual([
      'events.stream',
      'instructions.get',
    ]);
  });
});
