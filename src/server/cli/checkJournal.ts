import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isTaskId } from '../../core/rules/ids.js';
import { journalDir, writeDurably } from './runJournal.js';

/**
 * What the runner writes down about an actuality check it started (ADR-0030 §6): only what the
 * end needs, so that an end the board did not take survives the runner. It is a journal of its
 * own, apart from the journals of work runs (T45):
 *
 * - **its file** is `<ID>-check-<n>.json`; a work run's is `<ID>-<runId>.json` with an integer,
 *   so the two can never be the same file, and check 3 cannot overwrite the journal of run 3;
 * - **its schema** says `kind: 'check'` and `check: <n>` where a run's says `runId`. The schema
 *   of a work journal is not touched, and it reads every `.json` strictly, so it skips this one
 *   as unreadable, in this version and in every one before it. A check journal therefore never
 *   reaches `deliverEnd`, the `replaced` rule or `claude --recover`.
 *
 * It is written the way the others are (temporary file, `fsync`, rename, owner only) and never
 * holds the token.
 */
export const checkJournalSchema = z.strictObject({
  formatVersion: z.literal(1),
  kind: z.literal('check'),
  taskId: z.string().refine(isTaskId, 'Must be a task id, e.g. "T12"'),
  check: z.int().min(1),
  sessionId: z.uuid(),
  /** Set when `claude` ended, before the board is told. */
  outcome: z
    .strictObject({
      exitCode: z.int().optional(),
      launchError: z.string().min(1).optional(),
      endedAt: z.iso.datetime({ offset: true }),
    })
    .optional(),
});

export type CheckJournal = z.infer<typeof checkJournalSchema>;

const NAME = /^([A-Z]{1,10}[1-9][0-9]{0,8})-check-([1-9][0-9]*)\.json$/;

function checkFileName(taskId: string, check: number): string {
  return `${taskId}-check-${check}.json`;
}

export async function writeCheckJournal(root: string, record: CheckJournal): Promise<void> {
  const text = `${JSON.stringify(checkJournalSchema.parse(record), null, 2)}\n`;
  await writeDurably(root, checkFileName(record.taskId, record.check), text);
}

/** Every check journal of this board that can be read; a damaged one is left where it is. */
export async function listCheckJournals(root: string): Promise<CheckJournal[]> {
  let names: string[];
  try {
    names = await readdir(journalDir(root));
  } catch {
    return [];
  }
  const records = await Promise.all(
    names
      .filter((name) => NAME.test(name))
      .map((name) => parse(join(journalDir(root), name), name)),
  );
  return records.filter((record): record is CheckJournal => record !== undefined);
}

/** Removes the journal of this check; a taskId that is not a task id has none to remove. */
export async function removeCheckJournal(
  root: string,
  taskId: string,
  check: number,
): Promise<void> {
  if (!isTaskId(taskId) || !Number.isInteger(check) || check < 1) return;
  await rm(join(journalDir(root), checkFileName(taskId, check)), { force: true });
}

/** A journal counts only when the name and the record say the same task and check. */
async function parse(file: string, name: string): Promise<CheckJournal | undefined> {
  try {
    const result = checkJournalSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    if (!result.success) return undefined;
    const record = result.data;
    return checkFileName(record.taskId, record.check) === name ? record : undefined;
  } catch {
    return undefined;
  }
}
