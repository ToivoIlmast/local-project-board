import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ConsoleEvent } from '../../../contract/v1/console.js';
import { journalDir } from '../runJournal.js';

/**
 * The spool of a console run (plan §9.2): every event the runner makes gets the next `runnerSeq`
 * (1, 2, 3… without a gap) and is appended to `.board/runner/<ID>-<runId>.console.ndjson`, one
 * `{runnerSeq, event}` per line, before anything is sent. The uploader sends what the board has
 * not confirmed; the cursor of what it has confirmed is the caller's to keep (`runJournal`).
 *
 * The write is synchronous and not synced: it must be on the disk's side of the process before
 * `process.on('exit')` and a crash can take the runner, and a line is not worth an `fsync`. A
 * disk that refuses it does not stop the run: the events are kept in memory, as long as this
 * runner lives.
 */
export interface Spool {
  /** Appends the events and gives each its `runnerSeq`; the last one. */
  append(events: readonly ConsoleEvent[]): number;
  /** The `runnerSeq` of the last event made; 0 before the first. */
  lastSeq(): number;
  /** The cursor: the last `runnerSeq` the board confirmed. */
  acked(): number;
  /** The first `limit` events the board has not confirmed, and the `runnerSeq` of the first. */
  next(limit: number): { fromRunnerSeq: number; events: ConsoleEvent[] } | undefined;
  /** How many events the board has not confirmed. */
  unsent(): number;
  /** Moves the cursor forward; a cursor never moves back, nor past the last event. */
  ack(lastRunnerSeq: number): void;
  /** Deletes the file once everything is confirmed; otherwise it stays on the disk (§9.5). */
  finish(): boolean;
}

export function spoolFile(taskId: string, runId: number): string {
  return `${taskId}-${runId}.console.ndjson`;
}

export function createSpool(options: {
  root: string;
  taskId: string;
  runId: number;
  /** Where the cursor stood when this runner began: 0 for a new run. */
  acked?: number;
}): Spool {
  const file = join(journalDir(options.root), spoolFile(options.taskId, options.runId));
  const pending: ConsoleEvent[] = [];
  let acked = options.acked ?? 0;
  let last = acked;
  let writable = true;

  return {
    append(events) {
      if (events.length === 0) return last;
      let text = '';
      for (const event of events) {
        pending.push(event);
        last += 1;
        text += `${JSON.stringify({ runnerSeq: last, event })}\n`;
      }
      if (writable) {
        try {
          mkdirSync(journalDir(options.root), { recursive: true, mode: 0o700 });
          appendFileSync(file, text, { mode: 0o600 });
        } catch {
          writable = false;
        }
      }
      return last;
    },
    lastSeq: () => last,
    acked: () => acked,
    next(limit) {
      if (pending.length === 0) return undefined;
      return { fromRunnerSeq: acked + 1, events: pending.slice(0, limit) };
    },
    unsent: () => pending.length,
    ack(lastRunnerSeq) {
      const to = Math.min(lastRunnerSeq, last);
      if (to <= acked) return;
      pending.splice(0, to - acked);
      acked = to;
    },
    finish() {
      if (pending.length > 0) return false;
      try {
        rmSync(file, { force: true });
      } catch {
        // Left behind, harmless: the cursor says there is nothing in it to send.
      }
      return true;
    },
  };
}
