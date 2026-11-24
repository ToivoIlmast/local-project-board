import type { RequestHandler, Response } from 'express';
import { parseParams, parseQuery, routes, type InboxFrame } from '../../contract/v1/index.js';
import type { BoardEvent } from '../../core/events.js';
import { BoardError, type TaskService } from '../../core/index.js';
import type { AiRunService } from '../../core/services/aiRunService.js';
import { invalidRequest, HttpError } from './errors.js';
import { hasSessionToken } from './security.js';
import { SSE_HEARTBEAT_MS, SSE_RETRY_MS, type EventStream } from './sse.js';

/**
 * The runner's inbox of a console run (plan §9.3, C10): what the page hands the board on its way
 * to `claude`. A stream with the token, the runner's alone and never in the instructions of
 * agents. The registry is state of this server, not of the board: after a restart the runner
 * connects again and is sent what the journal still holds as `accepted`.
 *
 * It sends the messages of the journal that are `accepted`, in the order of `seq`, each once on a
 * connection; a message that the runner reported `queued` is its own from then on. A second
 * connection to the same run replaces the first. `close` and `kill` are sent when the page asks
 * and the service has taken it. `agent-final` follows a change of `aiRun.state` and leaves the
 * inbox open: the session does not depend on that state (§5.3). The inbox ends with the
 * `process.exited` of the journal, with `endedAt`, and when another run replaces the run.
 */
export interface Inbox {
  /** Sends the messages of the journal that are `accepted` and not yet sent on the connection. */
  notify(taskId: string, runId: number): void;
  /** Sends a frame to the runner of the run, if it is connected. */
  send(taskId: string, runId: number, frame: Extract<InboxFrame, { type: 'close' | 'kill' }>): void;
  /** The route a runner reads its inbox on; only the holder of the token may. */
  handler(token: string, options?: { heartbeatMs?: number | undefined }): RequestHandler;
}

export interface InboxDeps {
  tasks: Pick<TaskService, 'get'>;
  aiRun: Pick<AiRunService, 'readConsole'>;
  events: EventStream;
}

interface Connection {
  taskId: string;
  runId: number;
  sessionId: string;
  response: Response;
  /** The messages already written to this response. */
  sent: Set<string>;
  /** The `aiRun.state` the runner was last told of, or found. */
  agentState: string | undefined;
  /** Work on this connection, one after another: the frames keep the order they were asked in. */
  chain: Promise<void>;
  closed: boolean;
  stop: () => void;
}

const FINAL_STATES = ['finished', 'failed', 'needs-review'] as const;

export function createInbox({ tasks, aiRun, events }: InboxDeps): Inbox {
  const connections = new Map<string, Connection>();
  const keyOf = (taskId: string, runId: number): string => `${taskId}#${runId}`;

  const write = (connection: Connection, frame: InboxFrame): void => {
    if (!connection.closed) connection.response.write(`data: ${JSON.stringify(frame)}\n\n`);
  };

  const close = (connection: Connection): void => {
    if (connection.closed) return;
    connection.closed = true;
    connection.stop();
    forget(connection);
    connection.response.end();
  };

  const enqueue = (connection: Connection, work: () => Promise<void> | void): void => {
    connection.chain = connection.chain
      .then(async () => {
        if (!connection.closed) await work();
      })
      // The journal could not be read: the runner connects again and is told what is accepted.
      .catch(() => close(connection));
  };

  /** The journal is the truth: what is `accepted` and not yet written is written, by `seq`. */
  const flush = (connection: Connection): void =>
    enqueue(connection, async () => {
      const { state } = await aiRun.readConsole(connection.taskId, connection.runId, { limit: 1 });
      const accepted = state.messages
        .filter((message) => message.origin === 'board' && message.status === 'accepted')
        .sort((a, b) => a.acceptedSeq - b.acceptedSeq);
      for (const message of accepted) {
        if (connection.sent.has(message.messageId)) continue;
        connection.sent.add(message.messageId);
        write(connection, { type: 'message', messageId: message.messageId, text: message.text });
      }
      if (state.process.status === 'exited' || state.process.status === 'lost') close(connection);
    });

  /**
   * The inbox listens to the bus only while a runner is connected: the bus counts the clients of
   * the stream, and a board with no runner must not hold a listener there.
   */
  let unsubscribe: (() => void) | undefined;

  function forget(connection: Connection): void {
    const key = keyOf(connection.taskId, connection.runId);
    if (connections.get(key) === connection) connections.delete(key);
    if (connections.size === 0 && unsubscribe !== undefined) {
      unsubscribe();
      unsubscribe = undefined;
    }
  }

  const listen = (): void => {
    unsubscribe ??= events.subscribe(onEvent);
  };

  function onEvent(event: BoardEvent): void {
    if (event.type === 'console.appended') {
      const connection = connections.get(keyOf(event.taskId, event.runId));
      if (connection !== undefined) flush(connection);
      return;
    }
    if (event.type !== 'task.updated') return;
    const run = event.task.aiRun;
    for (const connection of [...connections.values()]) {
      if (connection.taskId !== event.task.id) continue;
      const current =
        run !== undefined &&
        (run.runId ?? 0) === connection.runId &&
        run.sessionId === connection.sessionId &&
        run.endedAt === undefined;
      if (!current) {
        // Whatever was asked before is written first; then the inbox of a run that is over ends.
        enqueue(connection, () => close(connection));
        continue;
      }
      if (run.state !== connection.agentState) {
        connection.agentState = run.state;
        const state = FINAL_STATES.find((final) => final === run.state);
        if (state !== undefined)
          enqueue(connection, () => write(connection, { type: 'agent-final', state }));
      }
    }
  }

  return {
    notify(taskId, runId) {
      const connection = connections.get(keyOf(taskId, runId));
      if (connection !== undefined) flush(connection);
    },

    send(taskId, runId, frame) {
      const connection = connections.get(keyOf(taskId, runId));
      if (connection !== undefined) enqueue(connection, () => write(connection, frame));
    },

    handler(token, { heartbeatMs = SSE_HEARTBEAT_MS } = {}) {
      return async (request, response) => {
        // A GET needs no token anywhere else. This one does: whatever is read here is what the
        // person said to the agent, and it is for the runner that holds the token.
        if (!hasSessionToken(request.headers.authorization, token)) {
          throw new HttpError(401, 'UNAUTHORIZED', 'Reading the inbox needs the session token.');
        }
        const route = routes['ai-run.console.inbox'];
        const params = parseParams(route, request.params);
        if (!params.ok) throw invalidRequest(params.issues);
        const query = parseQuery(route, request.query);
        if (!query.ok) throw invalidRequest(query.issues);
        const { id: taskId, runId } = params.data as { id: string; runId: number };
        const { sessionId } = query.data as { sessionId: string };

        const run = (await tasks.get(taskId)).aiRun;
        if (run === undefined || (run.runId ?? 0) !== runId || run.sessionId !== sessionId) {
          throw new BoardError(
            'STALE_AI_RUN',
            `Run ${runId} is not the current run for task "${taskId}".`,
            { id: taskId, runId },
          );
        }
        if (run.console !== true || run.endedAt !== undefined) {
          throw new BoardError(
            'CONSOLE_UNAVAILABLE',
            `The console of run ${runId} of task "${taskId}" does not take this now.`,
            { id: taskId, runId },
          );
        }

        response.status(200).set({
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
        });
        response.flushHeaders();
        response.write(`retry: ${SSE_RETRY_MS}\n\n`);

        const heartbeat = setInterval(() => response.write(':ping\n\n'), heartbeatMs);
        heartbeat.unref();
        const connection: Connection = {
          taskId,
          runId,
          sessionId,
          response,
          sent: new Set(),
          agentState: run.state,
          chain: Promise.resolve(),
          closed: false,
          stop: () => clearInterval(heartbeat),
        };
        // The second connection replaces the first: the old response may still hang (§9.3).
        const key = keyOf(taskId, runId);
        const old = connections.get(key);
        if (old !== undefined) close(old);
        connections.set(key, connection);
        listen();
        const gone = (): void => {
          connection.closed = true;
          connection.stop();
          forget(connection);
        };
        request.on('close', gone);
        response.on('close', gone);

        flush(connection);
      };
    },
  };
}
