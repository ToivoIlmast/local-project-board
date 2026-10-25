import type { RequestHandler, Response } from 'express';
import { parseQuery, routes, type RunRequest, type RunsQuery } from '../../contract/v1/index.js';
import { HttpError, invalidRequest } from './errors.js';
import { hasSessionToken } from './security.js';
import { SSE_HEARTBEAT_MS, SSE_RETRY_MS } from './sse.js';

/**
 * Send to AI → Claude Code, as far as the board goes (T27, ADR-0029). The board starts nothing:
 * a runner that the person started in a terminal of the project (`local-project-board claude
 * --wait`) waits on `GET /runs`, and a request is handed to exactly one of them, which then
 * starts the session itself. A request is a task id and the name of an agent, nothing more.
 *
 * One request per wait: the stream that carried it is ended, and the runner comes back only
 * when its session is over. So a runner in a session is not waiting, and a second click is
 * refused at once instead of being queued behind the person's back.
 *
 * A runner says which kinds it can start besides work (`?accepts=check,research`, D13): one of
 * an earlier version says nothing and is handed work only, so that a request it cannot read is
 * never handed to it and lost while the page is told "started".
 */
export interface RunDispatch {
  /**
   * Hands the request to one waiting runner that can start its kind, and lets it go. `nobody`
   * when none waits, `outdated` when some wait but none of them can start this kind.
   */
  hand(request: Omit<RunRequest, 'type'>): Handed;
  /** The route a runner waits on; only the holder of the token may wait there. */
  handler(token: string, options?: { heartbeatMs?: number | undefined }): RequestHandler;
}

export type Handed = 'handed' | 'nobody' | 'outdated';

type RunKind = NonNullable<RunRequest['kind']> | 'work';

interface Waiting {
  response: Response;
  accepts: ReadonlySet<RunKind>;
}

export function createRunDispatch(): RunDispatch {
  // In the order they came; the one that came last is the one the person just started.
  const waiting: Waiting[] = [];
  const forget = (response: Response): void => {
    const index = waiting.findIndex((runner) => runner.response === response);
    if (index !== -1) waiting.splice(index, 1);
  };

  return {
    hand(request) {
      if (waiting.length === 0) return 'nobody';
      const kind: RunKind = request.kind ?? 'work';
      const index = waiting.findLastIndex((runner) => runner.accepts.has(kind));
      if (index === -1) return 'outdated';
      const [runner] = waiting.splice(index, 1);
      const event: RunRequest = { type: 'run.requested', ...request };
      runner?.response.end(`data: ${JSON.stringify(event)}\n\n`);
      return 'handed';
    },

    handler(token, { heartbeatMs = SSE_HEARTBEAT_MS } = {}) {
      return (request, response) => {
        // A GET needs no token anywhere else. This one does: whoever waits here is told to
        // start an agent, and that is for the person who can change the board.
        if (!hasSessionToken(request.headers.authorization, token)) {
          throw new HttpError(401, 'UNAUTHORIZED', 'Waiting for runs needs the session token.');
        }
        const query = parseQuery(routes['runs.stream'], request.query);
        if (!query.ok) throw invalidRequest(query.issues);
        const { accepts = [] } = query.data as RunsQuery;
        response.status(200).set({
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
        });
        response.flushHeaders();
        response.write(`retry: ${SSE_RETRY_MS}\n\n`);
        waiting.push({ response, accepts: new Set<RunKind>(['work', ...accepts]) });

        const heartbeat = setInterval(() => response.write(':ping\n\n'), heartbeatMs);
        heartbeat.unref();
        const stop = (): void => {
          clearInterval(heartbeat);
          forget(response);
        };
        request.on('close', stop);
        response.on('close', stop);
      };
    },
  };
}

/**
 * What the page is told when nothing waits: how to start a runner, or the session itself. When
 * runners wait but none can start this kind, they are of an earlier version: update one.
 */
export function noRunner(taskId: string, why: Exclude<Handed, 'handed'> = 'nobody'): HttpError {
  if (why === 'outdated') {
    return new HttpError(
      409,
      'NO_AGENT_RUNNER',
      'The runner waiting for this board cannot start this kind of session: it is of an earlier ' +
        'version. Update local-project-board, start `npx local-project-board claude --wait` ' +
        'again and try again.',
      { id: taskId },
    );
  }
  return new HttpError(
    409,
    'NO_AGENT_RUNNER',
    'Nothing is waiting to start Claude Code for this board. In a terminal in the project, run ' +
      '`npx local-project-board claude --wait` once and try again, or start this task there ' +
      `with \`npx local-project-board claude ${taskId}\`. A runner in a session waits again ` +
      'when the session ends.',
    { id: taskId },
  );
}
