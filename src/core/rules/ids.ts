import { BoardError } from '../errors.js';

// Ids are used as directory and file names, so the format is deliberately narrow:
// upper-case letters (no digits, so "A1"+"1" can't be confused with "A"+"11") and a number.
const PREFIX = /^[A-Z]{1,10}$/;
const TASK_ID = /^[A-Z]{1,10}[1-9][0-9]{0,8}$/;
const REPORT_ID = /^R[1-9][0-9]{0,8}$/;
const TOPIC_ID = /^P[1-9][0-9]{0,8}$/;
const BLOCK_ID = /^K[1-9][0-9]{0,8}$/;

export const DEFAULT_TASK_ID_PREFIX = 'T';
export const REPORT_ID_PREFIX = 'R';
/** Topics and blocks have ids of their own, global across the board (ADR-0032 §2). */
export const TOPIC_ID_PREFIX = 'P';
export const BLOCK_ID_PREFIX = 'K';

export function isTaskIdPrefix(prefix: string): boolean {
  return PREFIX.test(prefix);
}

export function isTaskId(id: string): boolean {
  return TASK_ID.test(id);
}

export function isReportId(id: string): boolean {
  return REPORT_ID.test(id);
}

export function isTopicId(id: string): boolean {
  return TOPIC_ID.test(id);
}

export function isBlockId(id: string): boolean {
  return BLOCK_ID.test(id);
}

/**
 * A task id prefix the board refuses to start with: `K3` would match the task id pattern too,
 * so a task id could not be told from a block or a topic id (ADR-0032 §2).
 */
export function isReservedTaskIdPrefix(prefix: string): boolean {
  return prefix === TOPIC_ID_PREFIX || prefix === BLOCK_ID_PREFIX;
}

/** The number part of `id` under `prefix`, or null if `id` is not one of that prefix's ids. */
export function idNumber(prefix: string, id: string): number | null {
  const digits = new RegExp(`^${assertPrefix(prefix)}([1-9][0-9]*)$`).exec(id)?.[1];
  return digits === undefined ? null : Number(digits);
}

/** The highest number in use, or 0. Guards against ids that predate the stored sequence. */
export function highestIdNumber(prefix: string, ids: Iterable<string>): number {
  let max = 0;
  for (const id of ids) max = Math.max(max, idNumber(prefix, id) ?? 0);
  return max;
}

/**
 * The next id after `sequence` ids have been allocated.
 * Allocation is monotonic: an id is never handed out twice for one board (ADR-0020),
 * so callers persist the returned number and never derive it from the tasks alone.
 */
export function nextIdAfter(prefix: string, sequence: number): string {
  assertPrefix(prefix);
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new BoardError('INVALID_ID_SEQUENCE', `Invalid id sequence ${sequence}.`, { sequence });
  }
  return `${prefix}${sequence + 1}`;
}

export interface IdAllocation {
  id: string;
  /** To be persisted by the provider; the next allocation continues from it. */
  sequence: number;
}

/**
 * Allocate the next id for a board. `storedSequence` is how many ids the board has ever
 * handed out; `existingIds` only guards the case where it is behind (a hand-edited board,
 * or a future import). Deleting a task never lowers the sequence (ADR-0020).
 */
export function allocateId(
  prefix: string,
  storedSequence: number,
  existingIds: Iterable<string>,
): IdAllocation {
  const sequence = Math.max(storedSequence, highestIdNumber(prefix, existingIds));
  return { id: nextIdAfter(prefix, sequence), sequence: sequence + 1 };
}

/**
 * `allocateId` for a counter that can be lost: `storedSequence` is null when it is missing or
 * invalid, and is then recovered from `existingIds`. That is only safe when every file that
 * could hold an id was read: with any in `unreadable`, a recovered counter could hand out an id
 * again, so nothing is allocated (ADR-0032 §2, O-1). A valid counter needs no such guarantee.
 */
export function allocateRecoverableId(
  prefix: string,
  storedSequence: number | null,
  existingIds: Iterable<string>,
  unreadable: readonly string[],
): IdAllocation {
  if (storedSequence === null && unreadable.length > 0) {
    throw new BoardError(
      'ID_SEQUENCE_UNRECOVERABLE',
      `Cannot create a topic or a block: topics/sequence.json is missing or invalid, and ` +
        `${unreadable.join(', ')} cannot be read, so a new id could repeat one in use. ` +
        `Fix or remove the unreadable file, or restore sequence.json.`,
      { files: [...unreadable] },
    );
  }
  return allocateId(prefix, storedSequence ?? 0, existingIds);
}

function assertPrefix(prefix: string): string {
  if (!isTaskIdPrefix(prefix)) {
    throw new BoardError('INVALID_ID_PREFIX', `Invalid id prefix "${prefix}".`, { prefix });
  }
  return prefix;
}
