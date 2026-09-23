import { BoardError } from '../errors.js';

// Ids are used as directory and file names, so the format is deliberately narrow:
// upper-case letters (no digits, so "A1"+"1" can't be confused with "A"+"11") and a number.
const PREFIX = /^[A-Z]{1,10}$/;
const TASK_ID = /^[A-Z]{1,10}[1-9][0-9]{0,8}$/;
const REPORT_ID = /^R[1-9][0-9]{0,8}$/;

export const DEFAULT_TASK_ID_PREFIX = 'T';
export const REPORT_ID_PREFIX = 'R';

export function isTaskIdPrefix(prefix: string): boolean {
  return PREFIX.test(prefix);
}

export function isTaskId(id: string): boolean {
  return TASK_ID.test(id);
}

export function isReportId(id: string): boolean {
  return REPORT_ID.test(id);
}

/** `${prefix}${max + 1}` over existing ids with the same prefix. */
export function nextId(prefix: string, existingIds: Iterable<string>): string {
  if (!isTaskIdPrefix(prefix)) {
    throw new BoardError('INVALID_ID_PREFIX', `Invalid id prefix "${prefix}".`, { prefix });
  }
  const own = new RegExp(`^${prefix}([1-9][0-9]*)$`);
  let max = 0;
  for (const id of existingIds) {
    const n = own.exec(id)?.[1];
    if (n !== undefined) max = Math.max(max, Number(n));
  }
  return `${prefix}${max + 1}`;
}
