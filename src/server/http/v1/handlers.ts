import type { BodyOf, ParamsOf, QueryOf, ResponseOf, RouteId } from '../../../contract/v1/index.js';
import { documentFormat } from '../../../core/rules/documentName.js';
import type { BoardContext } from '../context.js';

/** A body that is text rather than JSON; the media type depends on the file, not the route. */
export interface TextBody {
  text: string;
  media: 'text/markdown' | 'text/html';
}

export function isTextBody(value: unknown): value is TextBody {
  return typeof value === 'object' && value !== null && 'text' in value && 'media' in value;
}

export interface RouteInput<K extends RouteId> {
  params: ParamsOf<K>;
  query: QueryOf<K>;
  body: BodyOf<K>;
}

/**
 * A handler receives what the contract has already validated and answers with what the
 * contract declares. Everything else — status codes, headers, serialization — is the
 * router's business, so a route stays "validate, call a service, answer" (§20).
 */
export type RouteHandler<K extends RouteId> = (
  context: BoardContext,
  input: RouteInput<K>,
) => Promise<ResponseOf<K> | TextBody>;

export type Handlers = { [K in RouteId]?: RouteHandler<K> };

/**
 * Declared in the contract, served by a later phase: the instructions endpoint (phase 9).
 * The event stream has no handler either, but for another reason: it is a stream, not an
 * answer, so the router hands it to the SSE serializer.
 */
export const PENDING_ROUTE_IDS = ['instructions.get'] as const satisfies readonly RouteId[];

const deleted = { deleted: true } as const;

export const handlers: Handlers = {
  'project.get': (context) => context.project.read(),

  'tasks.list': (context) => context.tasks.list(),
  'tasks.create': (context, { body }) => context.tasks.create(body),
  'tasks.get': (context, { params }) => context.tasks.get(params.id),
  'tasks.update': (context, { params, body }) => context.tasks.update(params.id, body),
  'tasks.move': (context, { params, body }) => context.tasks.move(params.id, body),
  'tasks.delete': async (context, { params }) => {
    await context.tasks.remove(params.id);
    return deleted;
  },

  'documents.list': (context, { params }) => context.documents.list(params.id),
  'documents.read': async (context, { params }) => ({
    text: await context.documents.read(params.id, params.name),
    media: documentFormat(params.name) === 'html' ? 'text/html' : 'text/markdown',
  }),
  'documents.write': (context, { params, body }) =>
    context.documents.write(params.id, params.name, body.content),
  'documents.delete': async (context, { params }) => {
    await context.documents.remove(params.id, params.name);
    return deleted;
  },

  'git.status': (context) => context.git.status(),
  'git.branches': (context) => context.git.branches(),
  'git.commits': (context, { query }) =>
    context.git.commits({ ref: query.ref, limit: query.limit }),
  'git.diff': (context, { query }) =>
    context.git.diff({ ref: query.ref, path: query.path, staged: query.staged }),

  'reports.list': (context) => context.reports.list(),
  'reports.create': (context, { body }) => context.reports.create(body),
  'reports.read': async (context, { params }) => {
    const text = await context.reports.read(params.id);
    const report = (await context.reports.list()).find((stored) => stored.id === params.id);
    // A markdown report is never served as HTML, whatever the route's default media says.
    return { text, media: report?.format === 'html' ? 'text/html' : 'text/markdown' };
  },
  'reports.delete': async (context, { params }) => {
    await context.reports.remove(params.id);
    return deleted;
  },
};
