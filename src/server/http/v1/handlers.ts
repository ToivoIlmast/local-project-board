import {
  generateInstructions,
  type BoardFacts,
  type BodyOf,
  type ParamsOf,
  type QueryOf,
  type ResponseOf,
  type RouteId,
} from '../../../contract/v1/index.js';
import { randomUUID } from 'node:crypto';
import { BoardError, type Project } from '../../../core/index.js';
import { LAUNCH_MESSAGE_MAX_LENGTH } from '../../../core/model/launch.js';
import { documentFormat } from '../../../core/rules/documentName.js';
import type { RouteContext } from '../context.js';
import { noRunner } from '../runs.js';
import { composeCheckHandoff, composeHandoff } from './handoff.js';

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
  context: RouteContext,
  input: RouteInput<K>,
) => Promise<ResponseOf<K> | TextBody>;

/**
 * Every route but the stream has a handler, and the type says so: a route added to the
 * contract does not compile until it is served. The stream is not an answer but a
 * connection, so the router hands it to the SSE serializer instead (§14).
 */
export type Handlers = {
  [K in Exclude<RouteId, 'events.stream' | 'runs.stream'>]: RouteHandler<K>;
};

const deleted = { deleted: true } as const;

/**
 * One line a page can show (K10): control characters, newlines included, become spaces, the
 * session token becomes `[token]`, and the rest is trimmed. Nothing left is no message.
 */
function cleanMessage(message: string, token: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- control characters are what is removed here.
  const line = message.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  const cleaned = line.split(token).join('[token]').trim().slice(0, LAUNCH_MESSAGE_MAX_LENGTH);
  return cleaned === '' ? undefined : cleaned;
}

/** What the instructions and the handoff say about the board itself. */
const boardFacts = (project: Project): BoardFacts => ({
  name: project.name,
  statuses: project.statuses,
  idPrefix: project.idPrefix,
});

export const handlers: Handlers = {
  'project.get': (context) => context.project.read(),
  'session.get': (context) => Promise.resolve({ token: context.session.token }),

  // The instructions describe this board, so they are generated per request: the statuses and
  // the id prefix an agent must obey are the ones this board is configured with right now.
  'instructions.get': async (context) => {
    const project = await context.project.read();
    return {
      text: generateInstructions({
        baseUrl: context.session.baseUrl,
        board: boardFacts(project),
        projectRules: context.ai.rules,
      }),
      media: 'text/markdown',
    };
  },

  // A task is read with its readiness beside it; the task itself stays what taskSchema says.
  'tasks.list': (context) => context.tasks.listWithReadiness(),
  'tasks.create': (context, { body }) => context.tasks.create(body),
  'tasks.get': (context, { params }) => context.tasks.getWithReadiness(params.id),
  'tasks.update': (context, { params, body }) => context.tasks.update(params.id, body),
  'tasks.move': (context, { params, body }) => context.tasks.move(params.id, body),
  'tasks.delete': async (context, { params }) => {
    await context.tasks.remove(params.id);
    return deleted;
  },

  'tasks.workflow': (context, { params }) => context.workflow.forTask(params.id),

  // Send to AI → Claude Code: the task must exist, and then it goes to one waiting runner or
  // to none. Nothing is started here (ADR-0029, T27); a work run writes only its `launch` (T94).
  'tasks.run': async (context, { params, body }) => {
    await context.tasks.get(params.id);
    if (body.kind === 'check' || body.kind === 'research') {
      // A check or a research is recorded apart from the run of the task and takes nothing from
      // it: it is not refused while a run works, nor while another check does (ADR-0030 §6,
      // R1). The comment goes to the runner, which puts it in the begin; the board keeps it
      // nowhere before that (ADR-0029 T54).
      const check = {
        taskId: params.id,
        agent: body.agent,
        kind: body.kind,
        ...(body.model === undefined ? {} : { model: body.model }),
      };
      const handed = context.runs.hand({
        ...check,
        ...(body.comment === undefined ? {} : { comment: body.comment }),
      });
      if (handed !== 'handed') throw noRunner(params.id, handed);
      return check;
    }
    // A work run is one action under the lock of the task (ADR-0029 T94, K6): the refusals of
    // L1 in their order — a run works (T45), Resume needs a session that is over (T36), Restart
    // a run that is over (T37), then readiness (T78) — then one runner is reserved, `launch` is
    // written, and only then is the runner told. Asking a runner is already telling it.
    const request = {
      taskId: params.id,
      agent: body.agent,
      ...(body.model === undefined ? {} : { model: body.model }),
      ...(body.mode === undefined || body.mode === 'new' ? {} : { mode: body.mode }),
    };
    const handed = await context.aiRun.requestWork(
      params.id,
      { mode: body.mode ?? 'new', requestId: randomUUID() },
      () => context.runs.reserve(request),
    );
    if (handed === undefined) throw noRunner(params.id);
    return request;
  },

  // The runner's word that the work run of a request did not begin (ADR-0029 T94, K8). Its
  // message is cleaned before anything keeps it, and the body is never logged (K10).
  'tasks.runFailure': (context, { params, body }) => {
    const message =
      body.message === undefined ? undefined : cleanMessage(body.message, context.session.token);
    return context.aiRun.runFailure(params.id, {
      requestId: body.requestId,
      kind: body.kind,
      ...(message === undefined ? {} : { message }),
    });
  },

  // One text for one task, generated on every request from what the services read now and
  // kept nowhere. It carries the live URL but never the token: whoever needs one asks for it.
  'tasks.handoff': async (context, { params }) => ({
    text: await composeHandoff(context, params.id, {
      baseUrl: context.session.baseUrl,
      board: boardFacts(await context.project.read()),
      projectRules: context.ai.rules,
    }),
    media: 'text/markdown',
  }),

  'versions.list': (context, { params }) => context.history.versions(params.id),
  'versions.get': (context, { params }) => context.history.version(params.id, params.n),
  'versions.restore': (context, { params, body }) =>
    context.history.restore(params.id, params.n, body),

  'checks.list': (context, { params }) => context.history.checks(params.id),
  'checks.get': (context, { params }) => context.history.check(params.id, params.n),
  'checks.begin': (context, { params, body }) => context.history.beginCheck(params.id, body),
  // What the agent of a check reads: the version it is pinned to and the rules, generated on
  // every request and kept nowhere. Like a handoff, it carries no token.
  'checks.handoff': async (context, { params }) => ({
    text: await composeCheckHandoff(context, params.id, params.n, {
      baseUrl: context.session.baseUrl,
    }),
    media: 'text/markdown',
  }),
  // The text of a research report, apart from the record (ADR-0030 R3); only a research has one.
  'checks.reportMarkdown': async (context, { params }) => {
    const text = await context.history.reportMarkdown(params.id, params.n);
    if (text === null) {
      throw new BoardError(
        'CHECK_NOT_FOUND',
        `Check ${params.n} of task "${params.id}" has no report text: it is not a research.`,
        { id: params.id, check: params.n },
      );
    }
    return { text, media: 'text/markdown' };
  },
  'checks.report': (context, { params, body }) => context.history.report(params.id, params.n, body),
  'checks.end': (context, { params, body }) => context.history.endCheck(params.id, params.n, body),
  'checks.decide': (context, { params, body }) => context.history.decide(params.id, params.n, body),

  'workflow.get': (context) => context.workflow.read(),
  'workflow.update': (context, { body }) => context.workflow.replace(body),

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

  'topics.list': (context) => context.topics.list(),
  'topics.create': (context, { body }) => context.topics.create(body),
  'topics.update': (context, { params, body }) => context.topics.update(params.id, body),
  'topics.delete': async (context, { params }) => {
    await context.topics.remove(params.id);
    return deleted;
  },
  'topics.createBlock': (context, { params, body }) => context.topics.createBlock(params.id, body),
  'topics.updateBlock': (context, { params, body }) =>
    context.topics.updateBlock(params.id, params.blockId, body),
  'topics.reorderBlocks': (context, { params, body }) =>
    context.topics.reorderBlocks(params.id, body.blocks),
  'topics.deleteBlock': async (context, { params }) => {
    await context.topics.removeBlock(params.id, params.blockId);
    return deleted;
  },

  'ai-run.begin': async (context, { params, body }) => context.aiRun.begin(params.id, body),

  'ai-run.end': async (context, { params, body }) =>
    context.aiRun.end(params.id, params.runId, body),

  'ai-run.abandon': async (context, { params, body }) =>
    context.aiRun.abandon(params.id, params.runId, body),

  'ai-run.report': async (context, { params, body }) =>
    context.aiRun.report(params.id, params.runId, body),
};
