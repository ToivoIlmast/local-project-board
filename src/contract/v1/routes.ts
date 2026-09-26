import { z } from 'zod';
import * as s from './schemas.js';

export const API_VERSION = 'v1';
export const API_BASE_PATH = `/api/${API_VERSION}`;

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type ResponseMedia =
  'application/json' | 'text/markdown' | 'text/html' | 'text/event-stream';

export interface RouteResponse<S extends z.ZodType = z.ZodType> {
  schema: S;
  /** Documents and reports are served as text; `.html` documents as text/html. */
  media: ResponseMedia;
}

export interface RouteExample {
  params?: unknown;
  query?: unknown;
  body?: unknown;
  response: unknown;
}

export interface Route<
  Params extends z.ZodObject = z.ZodObject,
  Query extends z.ZodObject = z.ZodObject,
  Request extends z.ZodType = z.ZodType,
  Response extends z.ZodType = z.ZodType,
> {
  id: string;
  method: HttpMethod;
  /** Without the /api/v1 prefix; `:name` marks a path parameter. */
  path: string;
  summary: string;
  params?: Params;
  query?: Query;
  request?: Request;
  response: RouteResponse<Response>;
  /** The status of a successful answer; 200 unless a route says otherwise. */
  successStatus?: 200 | 201;
  example: RouteExample;
  ai: {
    /** Whether the route appears in the instructions given to AI agents. */
    include: boolean;
  };
}

export function routeUrl(route: Route): string {
  return `${API_BASE_PATH}${route.path}`;
}

const json = <S extends z.ZodType>(schema: S): RouteResponse<S> => ({
  schema,
  media: 'application/json',
});

const taskParams = z.strictObject({ id: s.taskIdSchema });
const documentParams = z.strictObject({ id: s.taskIdSchema, name: s.documentNameSchema });
const reportParams = z.strictObject({ id: s.reportIdSchema });

const exampleTask = {
  id: 'T12',
  title: 'Extract the git adapter',
  status: 'in-progress',
  rank: 'a1',
  body: '## Context\n\nThe status parser still lives in the HTTP layer.\n',
  labels: ['refactor'],
  branch: 'feat/git-adapter',
  createdAt: '2026-09-21T09:00:00.000Z',
  updatedAt: '2026-09-21T11:30:00.000Z',
};

const exampleDefaults = {
  editCode: true,
  branch: true,
  checks: true,
  commit: true,
  push: false,
  report: true,
  startStatus: 'in-progress',
  finishStatus: null,
  baseBranch: null,
  checkCommand: null,
};

const exampleWorkflowState = {
  defaults: exampleDefaults,
  board: { push: false, checkCommand: 'npm test' },
  statuses: { backlog: { editCode: false } },
};

const exampleDocument = {
  taskId: 'T12',
  name: 'plan.md',
  size: 482,
  updatedAt: '2026-09-21T11:30:00.000Z',
};

const exampleReport = {
  id: 'R3',
  title: 'Dependency audit',
  format: 'html' as const,
  createdAt: '2026-09-21T11:30:00.000Z',
};

function route<
  Params extends z.ZodObject,
  Query extends z.ZodObject,
  Request extends z.ZodType,
  Response extends z.ZodType,
>(definition: Route<Params, Query, Request, Response>): Route<Params, Query, Request, Response> {
  return definition;
}

/** The single source for validation, frontend types and the AI instructions (ADR-0005). */
export const routes = {
  'project.get': route({
    id: 'project.get',
    method: 'GET',
    path: '/project',
    summary: 'Read the board: statuses, id prefix, git state and any unreadable files',
    response: json(s.projectSchema),
    example: {
      response: {
        name: 'dep-health',
        root: '/home/me/dep-health',
        statuses: ['backlog', 'todo', 'in-progress', 'done'],
        idPrefix: 'T',
        storage: { provider: 'markdown' },
        git: { available: true, branch: 'main', detached: false },
        version: '0.1.0',
        readIssues: [{ file: 'tasks/T7/task.md', message: 'Invalid YAML frontmatter' }],
      },
    },
    ai: { include: true },
  }),

  'session.get': route({
    id: 'session.get',
    method: 'GET',
    path: '/session',
    summary: "Read this run's session token, the one every change must be sent with",
    response: json(s.sessionSchema),
    // A placeholder, not a plausible token: nothing that looks like a secret is in the contract.
    example: { response: { token: '<session token>' } },
    ai: { include: true },
  }),

  'tasks.list': route({
    id: 'tasks.list',
    method: 'GET',
    path: '/tasks',
    summary: 'List every task, ordered by status and rank',
    response: json(z.array(s.taskSchema)),
    example: { response: [exampleTask] },
    ai: { include: true },
  }),

  'tasks.create': route({
    id: 'tasks.create',
    method: 'POST',
    path: '/tasks',
    summary: 'Create a task',
    request: s.createTaskRequestSchema,
    response: json(s.taskSchema),
    successStatus: 201,
    example: {
      body: {
        title: 'Extract the git adapter',
        status: 'in-progress',
        body: '## Context\n\nThe status parser still lives in the HTTP layer.\n',
        labels: ['refactor'],
      },
      response: exampleTask,
    },
    ai: { include: true },
  }),

  'tasks.get': route({
    id: 'tasks.get',
    method: 'GET',
    path: '/tasks/:id',
    summary: 'Read one task, including its markdown body',
    params: taskParams,
    response: json(s.taskSchema),
    example: { params: { id: 'T12' }, response: exampleTask },
    ai: { include: true },
  }),

  'tasks.update': route({
    id: 'tasks.update',
    method: 'PATCH',
    path: '/tasks/:id',
    summary: 'Change a task; only the given fields are written (last-write-wins)',
    params: taskParams,
    request: s.updateTaskRequestSchema,
    response: json(s.taskSchema),
    example: {
      params: { id: 'T12' },
      body: { status: 'done', labels: ['refactor', 'git'] },
      response: exampleTask,
    },
    ai: { include: true },
  }),

  'tasks.delete': route({
    id: 'tasks.delete',
    method: 'DELETE',
    path: '/tasks/:id',
    summary: 'Delete a task and its documents; the id is never reused',
    params: taskParams,
    response: json(s.deletedSchema),
    example: { params: { id: 'T12' }, response: { deleted: true } },
    ai: { include: true },
  }),

  'tasks.move': route({
    id: 'tasks.move',
    method: 'POST',
    path: '/tasks/:id/move',
    summary: 'Move a task to a status and between neighbours; the server computes the order',
    params: taskParams,
    request: s.moveTaskRequestSchema,
    response: json(s.taskSchema),
    example: {
      params: { id: 'T12' },
      body: { status: 'done', after: 'T4' },
      response: exampleTask,
    },
    ai: { include: true },
  }),

  'tasks.workflow': route({
    id: 'tasks.workflow',
    method: 'GET',
    path: '/tasks/:id/workflow',
    summary: 'Read the settings a task runs with, the source of each and which are inactive',
    params: taskParams,
    response: json(s.effectiveWorkflowSchema),
    example: {
      params: { id: 'T12' },
      response: {
        values: { ...exampleDefaults, editCode: false, checkCommand: 'npm test' },
        sources: {
          editCode: 'status',
          branch: 'default',
          checks: 'default',
          commit: 'default',
          push: 'board',
          report: 'default',
          startStatus: 'default',
          finishStatus: 'default',
          baseBranch: 'default',
          checkCommand: 'board',
        },
        inactive: ['branch', 'checks', 'commit', 'push'],
      },
    },
    ai: { include: true },
  }),

  'workflow.get': route({
    id: 'workflow.get',
    method: 'GET',
    path: '/workflow',
    summary: 'Read the AI workflow overrides of the board and its columns, with the defaults',
    response: json(s.workflowStateSchema),
    example: { response: exampleWorkflowState },
    ai: { include: true },
  }),

  'workflow.update': route({
    id: 'workflow.update',
    method: 'PUT',
    path: '/workflow',
    summary: 'Replace the AI workflow overrides of the board and all its columns (last-write-wins)',
    request: s.replaceWorkflowRequestSchema,
    response: json(s.workflowStateSchema),
    example: {
      body: {
        board: { push: false, checkCommand: 'npm test' },
        statuses: { backlog: { editCode: false } },
      },
      response: exampleWorkflowState,
    },
    // The Settings page sends the whole of it. An agent that rewrites the rules it works under
    // is not what these settings are for; it reads them and, for its own task, patches the task.
    ai: { include: false },
  }),

  'documents.list': route({
    id: 'documents.list',
    method: 'GET',
    path: '/tasks/:id/documents',
    summary: 'List the documents attached to a task',
    params: taskParams,
    response: json(z.array(s.documentMetaSchema)),
    example: { params: { id: 'T12' }, response: [exampleDocument] },
    ai: { include: true },
  }),

  'documents.read': route({
    id: 'documents.read',
    method: 'GET',
    path: '/tasks/:id/documents/:name',
    summary: 'Read a document as text',
    params: documentParams,
    response: { schema: z.string(), media: 'text/markdown' },
    example: {
      params: { id: 'T12', name: 'plan.md' },
      response: '# Plan\n\n1. Move the parser into server/git.\n',
    },
    ai: { include: true },
  }),

  'documents.write': route({
    id: 'documents.write',
    method: 'PUT',
    path: '/tasks/:id/documents/:name',
    summary: 'Create or overwrite a document (idempotent)',
    params: documentParams,
    request: s.writeDocumentRequestSchema,
    response: json(s.documentMetaSchema),
    example: {
      params: { id: 'T12', name: 'plan.md' },
      body: { content: '# Plan\n\n1. Move the parser into server/git.\n' },
      response: exampleDocument,
    },
    ai: { include: true },
  }),

  'documents.delete': route({
    id: 'documents.delete',
    method: 'DELETE',
    path: '/tasks/:id/documents/:name',
    summary: 'Delete a document',
    params: documentParams,
    response: json(s.deletedSchema),
    example: { params: { id: 'T12', name: 'plan.md' }, response: { deleted: true } },
    ai: { include: true },
  }),

  'git.status': route({
    id: 'git.status',
    method: 'GET',
    path: '/git/status',
    summary: 'Read the working tree status of the repository',
    response: json(s.gitStatusSchema),
    example: {
      response: {
        branch: 'feat/git-adapter',
        detached: false,
        clean: false,
        files: [{ path: 'src/server/git/status.ts', staged: false, status: 'modified' }],
      },
    },
    ai: { include: true },
  }),

  'git.branches': route({
    id: 'git.branches',
    method: 'GET',
    path: '/git/branches',
    summary: 'List local branches',
    response: json(z.array(s.gitBranchSchema)),
    example: {
      response: [
        { name: 'main', current: false },
        { name: 'feat/git-adapter', current: true },
      ],
    },
    ai: { include: true },
  }),

  'git.commits': route({
    id: 'git.commits',
    method: 'GET',
    path: '/git/commits',
    summary: 'List recent commits',
    query: z.strictObject({
      ref: s.gitRefSchema.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
    response: json(z.array(s.gitCommitSchema)),
    example: {
      query: { ref: 'main', limit: 20 },
      response: [
        {
          sha: '9f1c1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b',
          subject: 'Extract the git status parser',
          author: 'Toivo',
          date: '2026-09-21T11:30:00.000Z',
        },
      ],
    },
    ai: { include: true },
  }),

  'git.diff': route({
    id: 'git.diff',
    method: 'GET',
    path: '/git/diff',
    summary: 'Read a diff of the working tree or of a ref',
    query: z.strictObject({
      ref: s.gitRefSchema.optional(),
      path: s.gitPathSchema.optional(),
      staged: z.stringbool().optional(),
    }),
    response: json(s.gitDiffSchema),
    example: {
      query: { path: 'src/server/git/status.ts' },
      response: { text: '@@ -1,4 +1,6 @@\n-const a = 1;\n+const a = 2;\n', truncated: false },
    },
    ai: { include: true },
  }),

  'reports.list': route({
    id: 'reports.list',
    method: 'GET',
    path: '/reports',
    summary: 'List the reports stored on the board',
    response: json(z.array(s.reportSchema)),
    example: { response: [exampleReport] },
    ai: { include: true },
  }),

  'reports.create': route({
    id: 'reports.create',
    method: 'POST',
    path: '/reports',
    summary: 'Store an HTML or markdown report',
    request: s.createReportRequestSchema,
    response: json(s.reportSchema),
    successStatus: 201,
    example: {
      body: {
        title: 'Dependency audit',
        format: 'html',
        content: '<h1>Dependency audit</h1>\n<p>3 outdated packages.</p>\n',
      },
      response: exampleReport,
    },
    ai: { include: true },
  }),

  'reports.read': route({
    id: 'reports.read',
    method: 'GET',
    path: '/reports/:id',
    summary: 'Read a report as text',
    params: reportParams,
    response: { schema: z.string(), media: 'text/html' },
    example: {
      params: { id: 'R3' },
      response: '<h1>Dependency audit</h1>\n<p>3 outdated packages.</p>\n',
    },
    ai: { include: true },
  }),

  'reports.delete': route({
    id: 'reports.delete',
    method: 'DELETE',
    path: '/reports/:id',
    summary: 'Delete a report',
    params: reportParams,
    response: json(s.deletedSchema),
    example: { params: { id: 'R3' }, response: { deleted: true } },
    ai: { include: true },
  }),

  'events.stream': route({
    id: 'events.stream',
    method: 'GET',
    path: '/events',
    summary: 'Subscribe to board events (SSE); the UI uses it to stay in sync',
    response: { schema: s.boardEventSchema, media: 'text/event-stream' },
    example: { response: { type: 'task.updated', task: exampleTask } },
    // Agents poll the resources they changed; a stream is of no use to them.
    ai: { include: false },
  }),

  'instructions.get': route({
    id: 'instructions.get',
    method: 'GET',
    path: '/instructions',
    summary: 'Read these instructions as markdown',
    response: { schema: z.string(), media: 'text/markdown' },
    example: { response: '# local-project-board API (v1)\n' },
    ai: { include: false },
  }),
} as const;

export type Routes = typeof routes;
export type RouteId = keyof Routes;

export const routeList: Route[] = Object.values(routes);

/** What a schema yields; a route that declares none is described by the empty object. */
type Parsed<S> = S extends z.ZodType ? z.infer<S> : never;

export type ResponseOf<K extends RouteId> = z.infer<Routes[K]['response']['schema']>;
export type BodyOf<K extends RouteId> = Parsed<NonNullable<Routes[K]['request']>>;
export type ParamsOf<K extends RouteId> = Parsed<NonNullable<Routes[K]['params']>>;
export type QueryOf<K extends RouteId> = Parsed<NonNullable<Routes[K]['query']>>;
