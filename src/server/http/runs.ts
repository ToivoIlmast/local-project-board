import type { RequestHandler, Response } from 'express';
import type { RunRequest } from '../../contract/v1/index.js';
import { HttpError } from './errors.js';
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
 */
export interface RunDispatch {
  /** Hands the request to one waiting runner and lets it go; false when none waits. */
  hand(request: Omit<RunRequest, 'type'>): boolean;
  /** The route a runner waits on; only the holder of the token may wait there. */
  handler(token: string, options?: { heartbeatMs?: number | undefined }): RequestHandler;
}

export function createRunDispatch(): RunDispatch {
  // In the order they came; the one that came last is the one the person just started.
  const waiting: Response[] = [];
  const forget = (response: Response): void => {
    const index = waiting.indexOf(response);
    if (index !== -1) waiting.splice(index, 1);
  };

  return {
    hand(request) {
      const runner = waiting.pop();
      if (runner === undefined) return false;
      const event: RunRequest = { type: 'run.requested', ...request };
      runner.end(`data: ${JSON.stringify(event)}\n\n`);
      return true;
    },

    handler(token, { heartbeatMs = SSE_HEARTBEAT_MS } = {}) {
      return (request, response) => {
        // A GET needs no token anywhere else. This one does: whoever waits here is told to
        // start an agent, and that is for the person who can change the board.
        if (!hasSessionToken(request.headers.authorization, token)) {
          throw new HttpError(401, 'UNAUTHORIZED', 'Waiting for runs needs the session token.');
        }
        response.status(200).set({
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
        });
        response.flushHeaders();
        response.write(`retry: ${SSE_RETRY_MS}\n\n`);
        waiting.push(response);

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

/** What the page is told when nothing waits: how to start a runner, or the session itself. */
export function noRunner(taskId: string): HttpError {
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
