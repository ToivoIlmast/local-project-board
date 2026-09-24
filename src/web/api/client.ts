import {
  API_BASE_PATH,
  routes,
  type BodyOf,
  type ParamsOf,
  type QueryOf,
  type ResponseOf,
  type DocumentMeta,
  type GitCommit,
  type GitDiff,
  type GitStatus,
  type Project,
  type Report,
  type Route,
  type RouteId,
  type Task,
} from '../../contract/v1/index';
import { ApiError, errorFromResponse, malformedResponse, networkError, readJson } from './errors';
import type { FetchLike, RequestInitLike } from './http';

export interface BoardClientOptions {
  /** Where the board answers; by default the page's own origin. */
  baseUrl?: string | undefined;
  /** The transport; tests pass their own, the browser passes none. */
  fetch?: FetchLike | undefined;
}

/**
 * The only thing in the page that talks to the board. Every path, method and response shape
 * comes from `contract/v1`, so the UI cannot drift from the API it is served by (ADR-0005),
 * and the session token lives here and nowhere else (ADR-0008).
 */
export interface BoardClient {
  project(): Promise<Project>;
  instructions(): Promise<string>;
  /** This run's token. The page never shows it; the client sends it with changes. */
  session(): Promise<string>;

  listTasks(): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  createTask(input: BodyOf<'tasks.create'>): Promise<Task>;
  updateTask(id: string, patch: BodyOf<'tasks.update'>): Promise<Task>;
  moveTask(id: string, move: BodyOf<'tasks.move'>): Promise<Task>;
  deleteTask(id: string): Promise<void>;

  listDocuments(taskId: string): Promise<DocumentMeta[]>;
  readDocument(taskId: string, name: string): Promise<string>;
  writeDocument(taskId: string, name: string, content: string): Promise<DocumentMeta>;
  deleteDocument(taskId: string, name: string): Promise<void>;

  listReports(): Promise<Report[]>;
  readReport(id: string): Promise<string>;
  deleteReport(id: string): Promise<void>;

  gitStatus(): Promise<GitStatus>;
  gitCommits(limit: number): Promise<GitCommit[]>;
  gitDiff(query: { path?: string | undefined; staged?: boolean | undefined }): Promise<GitDiff>;

  /** Addresses for what the browser loads itself: a framed report, a document, the stream. */
  reportUrl(id: string): string;
  documentUrl(taskId: string, name: string): string;
  eventsUrl(): string;
}

interface CallInput<K extends RouteId> {
  params?: ParamsOf<K>;
  query?: QueryOf<K>;
  body?: BodyOf<K>;
}

export function createBoardClient(options: BoardClientOptions = {}): BoardClient {
  const baseUrl = (options.baseUrl ?? defaultBaseUrl()).replace(/\/+$/, '');
  const send = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  let token: string | undefined;

  /** The token is kept in this closure only: not in the DOM, not in storage, not in a URL. */
  async function session(refresh = false): Promise<string> {
    if (!refresh && token !== undefined) return token;
    token = undefined;
    const answer = await call('session.get', {});
    token = answer.token;
    return answer.token;
  }

  async function call<K extends RouteId>(
    id: K,
    input: CallInput<K>,
    retryOnStaleToken = true,
  ): Promise<ResponseOf<K>> {
    const route: Route = routes[id];
    const where = `${baseUrl}${API_BASE_PATH}${path(route, input.params)}${query(input.query)}`;

    const init: RequestInitLike = { method: route.method, headers: {} };
    const headers = init.headers as Record<string, string>;
    if (input.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(input.body);
    }
    // Reads need no token, so the board's page asks for one only where the server requires it.
    if (route.method !== 'GET') headers['Authorization'] = `Bearer ${await session()}`;

    let response;
    try {
      response = await send(where, init);
    } catch {
      throw networkError();
    }

    if (!response.ok) {
      const error = await errorFromResponse(response, `${route.method} ${route.path}`);
      // The board was restarted under an open page: one new token, one retry, then give up.
      if (error.status === 401 && retryOnStaleToken && route.method !== 'GET') {
        await session(true);
        return call(id, input, false);
      }
      throw error;
    }

    if (route.response.media !== 'application/json')
      return (await response.text()) as ResponseOf<K>;
    const parsed = route.response.schema.safeParse(await readJson(response));
    if (!parsed.success) throw malformedResponse(response.status, `${route.method} ${route.path}`);
    return parsed.data as ResponseOf<K>;
  }

  const url = (id: RouteId, params: Record<string, string> = {}): string =>
    `${baseUrl}${API_BASE_PATH}${path(routes[id], params)}`;

  return {
    project: () => call('project.get', {}),
    instructions: () => call('instructions.get', {}),
    session: () => session(),

    listTasks: () => call('tasks.list', {}),
    getTask: (id) => call('tasks.get', { params: { id } }),
    createTask: (body) => call('tasks.create', { body }),
    updateTask: (id, body) => call('tasks.update', { params: { id }, body }),
    moveTask: (id, body) => call('tasks.move', { params: { id }, body }),
    deleteTask: async (id) => {
      await call('tasks.delete', { params: { id } });
    },

    listDocuments: (id) => call('documents.list', { params: { id } }),
    readDocument: (id, name) => call('documents.read', { params: { id, name } }),
    writeDocument: (id, name, content) =>
      call('documents.write', { params: { id, name }, body: { content } }),
    deleteDocument: async (id, name) => {
      await call('documents.delete', { params: { id, name } });
    },

    listReports: () => call('reports.list', {}),
    readReport: (id) => call('reports.read', { params: { id } }),
    deleteReport: async (id) => {
      await call('reports.delete', { params: { id } });
    },

    gitStatus: () => call('git.status', {}),
    gitCommits: (limit) => call('git.commits', { query: { limit } }),
    gitDiff: (q) =>
      call('git.diff', {
        query: {
          ...(q.path === undefined ? {} : { path: q.path }),
          ...(q.staged === undefined ? {} : { staged: q.staged }),
        },
      }),

    reportUrl: (id) => url('reports.read', { id }),
    documentUrl: (taskId, name) => url('documents.read', { id: taskId, name }),
    eventsUrl: () => url('events.stream'),
  };
}

/** `/tasks/:id/documents/:name` with this call's values, each one escaped. */
function path(route: Route, params: unknown): string {
  const values = (params ?? {}) as Record<string, string>;
  return route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) =>
    encodeURIComponent(values[name] ?? ''),
  );
}

function query(values: unknown): string {
  const pairs = Object.entries((values ?? {}) as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return pairs.length === 0 ? '' : `?${pairs.join('&')}`;
}

function defaultBaseUrl(): string {
  return globalThis.location?.origin ?? '';
}

export { ApiError };
