import { API_BASE_PATH, runRequestSchema, type RunRequest } from '../../contract/v1/index.js';
import type { ResolvedBoard } from './board.js';
import { boardNotRunning, findClaude, startSession } from './claude.js';
import { deliverPendingCheckEnds } from './checkEnd.js';
import { startCheckSession } from './checkSession.js';
import { deliverPendingEnds } from './runEnd.js';
import { NotBegun, reportRunFailure } from './runFailure.js';
import { findRunningBoard } from './running.js';
import type { RuntimeState } from './runtime.js';

/** How long to wait before asking again for a board that stopped or a stream that broke. */
const RECONNECT_MS = 500;

/** The kinds this runner starts besides work (ADR-0029 T54). */
const ACCEPTS = 'check,research';

/** Said besides the kinds: this runner carries the trigger of a check into begin (T95, V1). */
const TRIGGER = 'trigger';

/** What this runner reports to the board (ADR-0029 T94, K11). */
const SIGNALS = 'run-failure';

export interface WaitEnvironment {
  env: NodeJS.ProcessEnv;
  write: (text: string) => void;
  writeError: (text: string) => void;
  /** Ends the wait as Ctrl+C does; the CLI has the signals of the process for that. */
  signal?: AbortSignal | undefined;
}

/**
 * `local-project-board claude --wait` (T27): the runner that makes Send to AI → Claude Code in
 * the board start a session. The person starts it once, in a terminal of the project; from then
 * on each task sent from the board starts Claude Code here, as `claude <ID>` would have, and
 * when the session ends the runner waits for the next one.
 *
 * The board only tells it which task (ADR-0029): which program, which argument and where are
 * decided here, the same way as for `claude <ID>`. While a session runs the runner does not
 * wait, so the board refuses a second click instead of queueing a task nobody sees coming.
 *
 * Resolves to 0 when it was asked to stop; a start that cannot work is refused before it waits.
 */
export async function waitForRuns(
  board: ResolvedBoard,
  environment: WaitEnvironment,
): Promise<number> {
  const { env, write, writeError } = environment;
  // Checked before it waits, so that the board never promises a start that cannot happen.
  await findClaude(env);
  let running: RuntimeState | undefined = await findRunningBoard(board.root);
  if (running === undefined) throw boardNotRunning();

  const stop = new AbortController();
  const abort = (): void => stop.abort();
  environment.signal?.addEventListener('abort', abort);
  let inSession = false;
  // Ctrl+C in a session belongs to Claude Code; between sessions it ends the wait.
  const interrupt = (): void => {
    if (!inSession) stop.abort();
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', abort);

  let toldGone = false;
  // The token of a board that refused `signals`: one of an earlier version. It is not offered
  // `signals` again, and a board with another token is (K11).
  let earlierBoard: string | undefined;
  try {
    while (!stop.signal.aborted) {
      running ??= await findRunningBoard(board.root);
      if (running === undefined) {
        if (!toldGone) write('The board stopped; waiting for it to start again.');
        toldGone = true;
        await pause(RECONNECT_MS, stop.signal);
        continue;
      }

      const current = running;
      // Ends that a runner before this one, or this one before the board restarted, could not
      // deliver: the board is here now (T45).
      await deliverPendingEnds(board.root);
      await deliverPendingCheckEnds(board.root);
      const signals = earlierBoard !== current.token;
      const onWaiting = (): void => {
        toldGone = false;
        write(
          `Waiting for Send to AI → Claude Code on the board at ${current.url}. ` +
            'Press Ctrl+C to stop.',
        );
      };
      // One attempt is at most three requests, each after a `400` to the one before, and
      // nothing was handed by a request that was refused (ADR-0029 T95, V2 and V6):
      // 1. with `trigger` and, unless this board's token is marked, `signals`;
      // 2. without `trigger`, with the same `signals`: a board of T94 knows `signals` only;
      // 3. only when 2 had `signals`: without them, and the board is marked as earlier (K11).
      // The refusal of `trigger` is not remembered: the next attempt asks with it again.
      let next = await nextRequest(current, stop.signal, { trigger: true, signals }, onWaiting);
      if (next === 'refused') {
        next = await nextRequest(current, stop.signal, { trigger: false, signals }, onWaiting);
      }
      if (next === 'refused' && signals) {
        earlierBoard = current.token;
        write('This board is of an earlier version: it will not show a failed start on the page.');
        next = await nextRequest(
          current,
          stop.signal,
          { trigger: false, signals: false },
          onWaiting,
        );
      }
      if (next === 'stopped') break;
      if (next === 'refused') next = 'lost';
      if (next === 'lost') {
        // The board went away or was restarted with another address and token: find it again.
        running = undefined;
        await pause(RECONNECT_MS, stop.signal);
        continue;
      }

      write(
        next.kind === 'check'
          ? `Starting Claude Code on a check of ${next.taskId}.`
          : next.kind === 'research'
            ? `Starting Claude Code on a research of ${next.taskId}.`
            : `Starting Claude Code on ${next.taskId}.`,
      );
      inSession = true;
      try {
        // Looked for again: `claude` may have gone since the wait began.
        const program = await findClaude(env).catch((error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          throw new NotBegun('claude-missing', text, text);
        });
        // A check and a research begin through the check routes, never through aiRun; the
        // comment of a research goes to the begin, not to the command line (ADR-0029 T54).
        const code =
          next.kind === 'check'
            ? await startCheckSession(
                program,
                next.taskId,
                current,
                board.root,
                env,
                next.model,
                undefined,
                next.trigger,
              )
            : next.kind === 'research'
              ? await startCheckSession(
                  program,
                  next.taskId,
                  current,
                  board.root,
                  env,
                  next.model,
                  { comment: next.comment },
                )
              : await startSession(
                  program,
                  next.taskId,
                  current,
                  board.root,
                  env,
                  next.model,
                  next.mode ?? 'new',
                );
        write(`The session on ${next.taskId} ended (exit code ${code}).`);
      } catch (error) {
        writeError(error instanceof Error ? error.message : String(error));
        // Only a request of work has an id, and only a start that never began is reported (K9).
        if (error instanceof NotBegun && next.requestId !== undefined) {
          const delivery = await reportRunFailure(board.root, next.taskId, next.requestId, error);
          if (delivery === 'undelivered' || delivery === 'refused') {
            writeError(
              `The board was not told that Claude Code did not start on ${next.taskId}; ` +
                'its page still shows the request as sent.',
            );
          }
        }
      } finally {
        inSession = false;
      }
    }
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', abort);
    environment.signal?.removeEventListener('abort', abort);
  }
  return 0;
}

/**
 * Waits on `GET /runs` for one request. `lost` when the stream ends or breaks without one —
 * the board stopped or restarted — and `stopped` when the wait was ended from here.
 */
async function nextRequest(
  board: RuntimeState,
  signal: AbortSignal,
  declare: { trigger: boolean; signals: boolean },
  onWaiting: () => void,
): Promise<RunRequest | 'lost' | 'stopped' | 'refused'> {
  // A stop that came while the ends were delivered fires no event any more: it is read here.
  if (signal.aborted) return 'stopped';
  const connection = new AbortController();
  const abort = (): void => connection.abort();
  signal.addEventListener('abort', abort);
  try {
    // Says what this runner can start, so that the board hands it nothing it cannot (D13).
    const accepts = declare.trigger ? `${ACCEPTS},${TRIGGER}` : ACCEPTS;
    const query = `accepts=${accepts}${declare.signals ? `&signals=${SIGNALS}` : ''}`;
    const response = await fetch(`${board.url}${API_BASE_PATH.slice(1)}/runs?${query}`, {
      headers: { authorization: `Bearer ${board.token}` },
      signal: connection.signal,
    });
    // A board of an earlier version parses the query strictly and refuses what it does not know:
    // `signals` (K11) or `trigger` (T95). Which one is for the caller to conclude.
    if (response.status === 400) return 'refused';
    if (!response.ok || response.body === null) return 'lost';
    // The board counts this runner from the moment it answered; only now is it true.
    onWaiting();

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      for (let split = buffer.indexOf('\n\n'); split !== -1; split = buffer.indexOf('\n\n')) {
        const request = parseFrame(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        if (request !== undefined) return request;
      }
    }
    return 'lost';
  } catch {
    return signal.aborted ? 'stopped' : 'lost';
  } finally {
    signal.removeEventListener('abort', abort);
    connection.abort();
  }
}

/** A request, or nothing for a comment, a heartbeat or anything that is not one. */
function parseFrame(frame: string): RunRequest | undefined {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n');
  if (data === '') return undefined;
  try {
    const parsed = runRequestSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}
