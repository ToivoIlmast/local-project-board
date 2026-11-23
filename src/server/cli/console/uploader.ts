import { CONSOLE_EVENTS_MAX_BATCH, consoleEventsResponse } from '../../../contract/v1/console.js';
import { findRunningBoard, post } from '../running.js';
import type { Spool } from './spool.js';

/**
 * Sends the spool of a console run to the board, one request at a time (plan §9.2). A batch is
 * `{fromRunnerSeq: acked + 1, events}` with up to 50 events, made after at most 250 ms. The
 * answer's `lastRunnerSeq` is the cursor: it moves, and is handed to `onAcked` to be written down.
 * A batch that got no answer — a timeout, a board that went away — is sent again from the same
 * `fromRunnerSeq`, and may be longer by then; the board skips what it has by `runnerSeq` (§3.3).
 *
 * The board is looked for afresh with every request, as `deliverEnd` does: one that restarted has
 * another address and token. While the session lives the uploader retries for as long as it takes;
 * `drain` gives it a time and then lets the end go on without the rest (the end matters more than
 * the tape, and the rest stays in the spool).
 */
export interface Uploader {
  /** New events are in the spool: send them soon. */
  notify(): void;
  /** Sends what is left, within `budgetMs`; true when the board confirmed all of it. */
  drain(budgetMs: number): Promise<boolean>;
  /** Stops the timers; nothing is sent after this. */
  stop(): void;
}

export interface UploaderOptions {
  root: string;
  taskId: string;
  runId: number;
  sessionId: string;
  spool: Spool;
  /** The cursor moved: write it into the journal of the run. */
  onAcked: (ackedRunnerSeq: number) => Promise<void>;
  /** The board was reached, lost or refused the events: a fixed word and a status, no more. */
  onConnection: (what: 'board-connected' | 'board-lost' | 'board-refused', detail?: string) => void;
  batchDelayMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
}

/** What the board answers when the run is not one it takes events for any more. */
const REFUSED = new Set([400, 404, 409, 422]);

export function createUploader(options: UploaderOptions): Uploader {
  const { spool } = options;
  const batchDelay = options.batchDelayMs ?? 250;
  const retryInitial = options.retryInitialMs ?? 200;
  const retryMax = options.retryMaxMs ?? 5_000;
  const path =
    `/tasks/${options.taskId}/ai-run/${options.runId}/console/events` +
    `?sessionId=${options.sessionId}`;

  let timer: NodeJS.Timeout | undefined;
  let pumping: Promise<void> | undefined;
  let deadline: number | undefined;
  let stopped = false;
  let refused = false;
  let connected: boolean | undefined;
  let wake: (() => void) | undefined;

  const connection = (reached: boolean, what: 'board-connected' | 'board-lost'): void => {
    if (connected === reached) return;
    connected = reached;
    options.onConnection(what);
  };

  /** One request. `done` when the board took the batch, `retry` when it is for another try. */
  async function attempt(): Promise<'done' | 'retry' | 'refused' | 'empty'> {
    const batch = spool.next(CONSOLE_EVENTS_MAX_BATCH);
    if (batch === undefined) return 'empty';
    const board = await findRunningBoard(options.root);
    if (board === undefined) {
      connection(false, 'board-lost');
      return 'retry';
    }
    const answer = await post(board, path, batch);
    if (answer === undefined) {
      connection(false, 'board-lost');
      return 'retry';
    }
    if (REFUSED.has(answer.status)) {
      options.onConnection('board-refused', String(answer.status));
      return 'refused';
    }
    if (!answer.ok) {
      // 401 is a token of a board that has gone; the next look finds the new one.
      connection(false, 'board-lost');
      return 'retry';
    }
    const parsed = consoleEventsResponse.safeParse(await answer.json().catch(() => undefined));
    if (!parsed.success) {
      connection(false, 'board-lost');
      return 'retry';
    }
    connection(true, 'board-connected');
    const before = spool.acked();
    spool.ack(parsed.data.lastRunnerSeq);
    if (spool.acked() === before) return 'retry';
    await options.onAcked(spool.acked()).catch(() => undefined);
    return 'done';
  }

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(handle);
        wake = undefined;
        resolve();
      };
      const handle = setTimeout(done, ms);
      wake = done;
    });

  async function pump(): Promise<void> {
    let delay = retryInitial;
    while (!stopped && !refused && spool.unsent() > 0) {
      const result = await attempt();
      if (result === 'refused') {
        refused = true;
      } else if (result === 'retry') {
        const left = deadline === undefined ? delay : deadline - Date.now();
        if (left <= 0) return;
        await sleep(Math.min(delay, left));
        delay = Math.min(delay * 2, retryMax);
      } else {
        delay = retryInitial;
      }
    }
  }

  const start = (): Promise<void> => {
    pumping ??= pump().finally(() => {
      pumping = undefined;
    });
    return pumping;
  };

  return {
    notify() {
      if (stopped || refused || timer !== undefined || pumping !== undefined) return;
      timer = setTimeout(
        () => {
          timer = undefined;
          void start();
        },
        spool.unsent() >= CONSOLE_EVENTS_MAX_BATCH ? 0 : batchDelay,
      );
    },
    async drain(budgetMs) {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      deadline = Date.now() + budgetMs;
      await start();
      // Events made while the last request was on its way.
      while (!stopped && !refused && spool.unsent() > 0 && Date.now() < deadline) await start();
      return spool.unsent() === 0;
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      wake?.();
    },
  };
}
