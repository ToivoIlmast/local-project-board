import { API_BASE_PATH, runRequestSchema, type RunRequest } from '../../contract/v1/index.js';
import type { ResolvedBoard } from './board.js';
import { boardNotRunning, findClaude, startSession } from './claude.js';
import { findRunningBoard } from './running.js';
import type { RuntimeState } from './runtime.js';

/** How long to wait before asking again for a board that stopped or a stream that broke. */
const RECONNECT_MS = 500;

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
      const next = await nextRequest(current, stop.signal, () => {
        toldGone = false;
        write(
          `Waiting for Send to AI → Claude Code on the board at ${current.url}. ` +
            'Press Ctrl+C to stop.',
        );
      });
      if (next === 'stopped') break;
      if (next === 'lost') {
        // The board went away or was restarted with another address and token: find it again.
        running = undefined;
        await pause(RECONNECT_MS, stop.signal);
        continue;
      }

      write(`Starting Claude Code on ${next.taskId}.`);
      inSession = true;
      try {
        // Looked for again: `claude` may have gone since the wait began.
        const program = await findClaude(env);
        const code = await startSession(program, next.taskId, current, board.root, env);
        write(`The session on ${next.taskId} ended (exit code ${code}).`);
      } catch (error) {
        writeError(error instanceof Error ? error.message : String(error));
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
  onWaiting: () => void,
): Promise<RunRequest | 'lost' | 'stopped'> {
  const connection = new AbortController();
  const abort = (): void => connection.abort();
  signal.addEventListener('abort', abort);
  try {
    const response = await fetch(`${board.url}${API_BASE_PATH.slice(1)}/runs`, {
      headers: { authorization: `Bearer ${board.token}` },
      signal: connection.signal,
    });
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
