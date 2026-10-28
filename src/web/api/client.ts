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
  type WorkflowState,
  type EffectiveWorkflow,
  type RunStarted,
  type RunTaskRequest,
  type Check,
  type CheckSummary,
  type Decision,
  type DecisionRequest,
  type RestoreVersionResponse,
  type TaskVersion,
  type VersionList,
} from '../../contract/v1/index';
import {
  ApiError,
  abortedError,
  errorFromResponse,
  malformedResponse,
  networkError,
  readJson,
  timeoutError,
} from './errors';
import type { FetchLike, RequestInitLike } from './http';

export interface BoardClientOptions {
  /** Where the board answers; by default the page's own origin. */
  baseUrl?: string | undefined;
  /** The transport; tests pass their own, the browser passes none. */
  fetch?: FetchLike | undefined;
  /** How long a request may take before it fails with `TIMEOUT`; by default `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
}

/** What one call may add: the caller's own way to cancel it, and a deadline of its own. */
export interface RequestOptions {
  /** Aborting it ends the request with `ABORTED`. */
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Every route of the board answers in milliseconds, `git status` of a large repository in a
 * few seconds; a request that has had this long is not coming back.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The only thing in the page that talks to the board. Every path, method and response shape
 * comes from `contract/v1`, so the UI cannot drift from the API it is served by (ADR-0005),
 * and the session token lives here and nowhere else (ADR-0008).
 */
export interface BoardClient {
  project(options?: RequestOptions): Promise<Project>;
  instructions(options?: RequestOptions): Promise<string>;
  /** This run's token. The page never shows it; the client sends it with changes. */
  session(options?: RequestOptions): Promise<string>;

  listTasks(options?: RequestOptions): Promise<Task[]>;
  getTask(id: string, options?: RequestOptions): Promise<Task>;
  createTask(input: BodyOf<'tasks.create'>, options?: RequestOptions): Promise<Task>;
  updateTask(id: string, patch: BodyOf<'tasks.update'>, options?: RequestOptions): Promise<Task>;
  moveTask(id: string, move: BodyOf<'tasks.move'>, options?: RequestOptions): Promise<Task>;
  deleteTask(id: string, options?: RequestOptions): Promise<void>;

  /** The overrides of the board and of its columns, with the defaults they lie over. */
  workflow(options?: RequestOptions): Promise<WorkflowState>;
  /** Replaces the overrides of the board and of all its columns; send both sections whole. */
  updateWorkflow(
    overrides: BodyOf<'workflow.update'>,
    options?: RequestOptions,
  ): Promise<WorkflowState>;
  /** What one task runs with and where each value comes from; computed by the board, not stored. */
  taskWorkflow(id: string, options?: RequestOptions): Promise<EffectiveWorkflow>;
  /** The text to give an agent for one task: the task, the steps its settings call for, the API. */
  handoff(id: string, options?: RequestOptions): Promise<string>;
  /**
   * Hands the task to the runner waiting in a terminal of the project, which starts the agent
   * (T27). The name of the agent is sent, and the model when one was chosen (T38); what starts
   * is the runner's business.
   */
  runTask(id: string, request: RunTaskRequest, options?: RequestOptions): Promise<RunStarted>;

  /** The versions of a task's content, and whether the task is at the latest (ADR-0030). */
  versions(taskId: string, options?: RequestOptions): Promise<VersionList>;
  /** One version with its snapshot; a version never changes, so it can be kept. */
  version(taskId: string, number: number, options?: RequestOptions): Promise<TaskVersion>;
  /** Writes the snapshot of a version as the content of the task, as a new version. */
  restoreVersion(
    taskId: string,
    number: number,
    ifContentHash: string,
    options?: RequestOptions,
  ): Promise<RestoreVersionResponse>;
  /** The checks of a task, actuality checks and research alike, newest last. */
  checks(taskId: string, options?: RequestOptions): Promise<CheckSummary[]>;
  check(taskId: string, number: number, options?: RequestOptions): Promise<Check>;
  /** The markdown of a published research report, as it was written (ADR-0030 R3). */
  checkReportMarkdown(taskId: string, number: number, options?: RequestOptions): Promise<string>;
  /** The person's decision on one recommendation of a reported check. */
  decide(
    taskId: string,
    number: number,
    decision: DecisionRequest,
    options?: RequestOptions,
  ): Promise<Decision>;

  listDocuments(taskId: string, options?: RequestOptions): Promise<DocumentMeta[]>;
  readDocument(taskId: string, name: string, options?: RequestOptions): Promise<string>;
  writeDocument(
    taskId: string,
    name: string,
    content: string,
    options?: RequestOptions,
  ): Promise<DocumentMeta>;
  deleteDocument(taskId: string, name: string, options?: RequestOptions): Promise<void>;

  listReports(options?: RequestOptions): Promise<Report[]>;
  readReport(id: string, options?: RequestOptions): Promise<string>;
  deleteReport(id: string, options?: RequestOptions): Promise<void>;

  gitStatus(options?: RequestOptions): Promise<GitStatus>;
  gitCommits(limit: number, ref?: string, options?: RequestOptions): Promise<GitCommit[]>;
  gitDiff(
    query: { path?: string | undefined; staged?: boolean | undefined },
    options?: RequestOptions,
  ): Promise<GitDiff>;

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
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let token: string | undefined;

  /** The token is kept in this closure only: not in the DOM, not in storage, not in a URL. */
  async function session(refresh = false, request: RequestOptions = {}): Promise<string> {
    if (!refresh && token !== undefined) return token;
    token = undefined;
    const answer = await call('session.get', {}, request);
    token = answer.token;
    return answer.token;
  }

  async function call<K extends RouteId>(
    id: K,
    input: CallInput<K>,
    request: RequestOptions = {},
    retryOnStaleToken = true,
  ): Promise<ResponseOf<K>> {
    const route: Route = routes[id];
    const where = `${baseUrl}${API_BASE_PATH}${path(route, input.params)}${query(input.query)}`;
    const what = `${route.method} ${route.path}`;

    const init: RequestInitLike = { method: route.method, headers: {} };
    const headers = init.headers as Record<string, string>;
    if (input.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(input.body);
    }
    // Reads need no token, so the board's page asks for one only where the server requires it.
    if (route.method !== 'GET')
      headers['Authorization'] = `Bearer ${await session(false, request)}`;

    const answer = await withDeadline(
      what,
      request.signal,
      request.timeoutMs ?? timeoutMs,
      async (signal) => {
        init.signal = signal;
        let response;
        try {
          response = await send(where, init);
        } catch {
          throw networkError();
        }

        if (!response.ok) return { error: await errorFromResponse(response, what) };

        if (route.response.media !== 'application/json')
          return { value: (await response.text()) as ResponseOf<K> };
        const parsed = route.response.schema.safeParse(await readJson(response));
        if (!parsed.success) throw malformedResponse(response.status, what);
        return { value: parsed.data as ResponseOf<K> };
      },
    );

    if ('value' in answer) return answer.value;
    // The board was restarted under an open page: one new token, one retry, then give up.
    if (answer.error.status === 401 && retryOnStaleToken && route.method !== 'GET') {
      await session(true, request);
      return call(id, input, request, false);
    }
    throw answer.error;
  }

  const url = (id: RouteId, params: Record<string, string> = {}): string =>
    `${baseUrl}${API_BASE_PATH}${path(routes[id], params)}`;

  return {
    project: (o) => call('project.get', {}, o),
    instructions: (o) => call('instructions.get', {}, o),
    session: (o) => session(false, o),

    listTasks: (o) => call('tasks.list', {}, o),
    getTask: (id, o) => call('tasks.get', { params: { id } }, o),
    createTask: (body, o) => call('tasks.create', { body }, o),
    updateTask: (id, body, o) => call('tasks.update', { params: { id }, body }, o),
    moveTask: (id, body, o) => call('tasks.move', { params: { id }, body }, o),
    deleteTask: async (id, o) => {
      await call('tasks.delete', { params: { id } }, o);
    },

    workflow: (o) => call('workflow.get', {}, o),
    updateWorkflow: (body, o) => call('workflow.update', { body }, o),
    taskWorkflow: (id, o) => call('tasks.workflow', { params: { id } }, o),
    handoff: (id, o) => call('tasks.handoff', { params: { id } }, o),
    runTask: (id, body, o) => call('tasks.run', { params: { id }, body }, o),

    versions: (id, o) => call('versions.list', { params: { id } }, o),
    version: (id, n, o) => call('versions.get', { params: { id, n } }, o),
    restoreVersion: (id, n, ifContentHash, o) =>
      call('versions.restore', { params: { id, n }, body: { ifContentHash } }, o),
    checks: (id, o) => call('checks.list', { params: { id } }, o),
    check: (id, n, o) => call('checks.get', { params: { id, n } }, o),
    checkReportMarkdown: (id, n, o) => call('checks.reportMarkdown', { params: { id, n } }, o),
    decide: (id, n, body, o) => call('checks.decide', { params: { id, n }, body }, o),

    listDocuments: (id, o) => call('documents.list', { params: { id } }, o),
    readDocument: (id, name, o) => call('documents.read', { params: { id, name } }, o),
    writeDocument: (id, name, content, o) =>
      call('documents.write', { params: { id, name }, body: { content } }, o),
    deleteDocument: async (id, name, o) => {
      await call('documents.delete', { params: { id, name } }, o);
    },

    listReports: (o) => call('reports.list', {}, o),
    readReport: (id, o) => call('reports.read', { params: { id } }, o),
    deleteReport: async (id, o) => {
      await call('reports.delete', { params: { id } }, o);
    },

    gitStatus: (o) => call('git.status', {}, o),
    gitCommits: (limit, ref, o) =>
      call('git.commits', { query: { limit, ...(ref !== undefined ? { ref } : {}) } }, o),
    gitDiff: (q, o) =>
      call(
        'git.diff',
        {
          query: {
            ...(q.path === undefined ? {} : { path: q.path }),
            ...(q.staged === undefined ? {} : { staged: q.staged }),
          },
        },
        o,
      ),

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

/**
 * Runs one request under a deadline and the caller's own signal, whichever comes first. The
 * race does not trust the transport to honour the signal: a request the browser keeps queued,
 * or a body that never ends, still settles here. A timeout and a caller's abort are told apart
 * by the error's code, and both the timer and the listener are gone once the request settles.
 */
async function withDeadline<T>(
  what: string,
  external: AbortSignal | undefined,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (external?.aborted) throw abortedError(what);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  const forward = (): void => controller.abort();
  external?.addEventListener('abort', forward, { once: true });
  const stopped = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

  try {
    return await Promise.race([run(controller.signal), stopped]);
  } catch (error) {
    if (timedOut) throw timeoutError(what, ms);
    if (external?.aborted) throw abortedError(what);
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', forward);
    // Settled: the race is over, and whatever the transport still does is no longer awaited.
    controller.abort();
  }
}

function defaultBaseUrl(): string {
  return globalThis.location?.origin ?? '';
}

export { ApiError };
