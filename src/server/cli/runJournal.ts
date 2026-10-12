import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isTaskId } from '../../core/rules/ids.js';

/**
 * What a runner writes down about the run it started, on the disk of this machine (T45), so
 * that what it knows outlives it:
 *
 * - **which processes** are the run: the runner and `claude`, each by pid **and start time**, so
 *   that a reused pid is never taken for them, with the boot and the PID namespace they belong
 *   to. `claude --recover` reads it to tell a lost run from a live one.
 * - **how the run ended**, written before the board is told. An end the board did not take — it
 *   was down, it restarted with another token, the runner was killed while it retried — stays
 *   here, and the next runner, `claude <ID>` or `claude --recover` delivers it.
 *
 * Memory is not enough for either: a runner that dies takes its memory with it, and that is
 * the case this file is for. It lives in the untracked `.board/` beside `runtime.json`
 * (ADR-0001), is readable by its owner only, and never holds the token.
 */
export const RUNNER_DIR = 'runner';

const processSchema = z.strictObject({
  pid: z.int().positive(),
  /** Start time of the process in clock ticks since boot (`/proc/<pid>/stat`, field 22). */
  start: z.string().regex(/^\d+$/).optional(),
});

export const runJournalSchema = z.strictObject({
  formatVersion: z.literal(1),
  /** Names the journal's file and the board's URL: a task id, or the journal is not read. */
  taskId: z.string().refine(isTaskId, 'Must be a task id, e.g. "T12"'),
  runId: z.int().nonnegative(),
  sessionId: z.uuid(),
  host: z.string(),
  platform: z.string(),
  bootId: z.string().optional(),
  pidNamespace: z.string().optional(),
  runner: processSchema,
  /** Set once `claude` was spawned; absent while it is being started. */
  child: processSchema.optional(),
  /** Set when `claude` ended, before the board is told. */
  outcome: z
    .strictObject({
      exitCode: z.int().optional(),
      launchError: z.string().min(1).optional(),
      endedAt: z.iso.datetime({ offset: true }),
    })
    .optional(),
});

export type RunJournal = z.infer<typeof runJournalSchema>;

export function journalDir(root: string): string {
  return join(root, '.board', RUNNER_DIR);
}

function journalPath(root: string, taskId: string, runId: number): string {
  return join(journalDir(root), `${taskId}-${runId}.json`);
}

/**
 * Written whole or not at all, and on the disk before it returns: a journal that a crash
 * could leave half-written, or only in a cache, would not be worth keeping.
 */
export async function writeJournal(root: string, record: RunJournal): Promise<void> {
  const dir = journalDir(root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = journalPath(root, record.taskId, record.runId);
  const temp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await open(temp, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(runJournalSchema.parse(record), null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
    await syncDir(dir);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** The rename itself is on the disk only when the directory is; not every system allows it. */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows cannot open a directory; the rename is as durable as the system makes it.
  }
}

/** The journal of this run, or nothing when there is none or it cannot be read as one. */
export async function readJournal(
  root: string,
  taskId: string,
  runId: number,
): Promise<RunJournal | undefined> {
  return parse(journalPath(root, taskId, runId));
}

/** Every journal of this board that can be read; a damaged one is left where it is. */
export async function listJournals(root: string): Promise<RunJournal[]> {
  let names: string[];
  try {
    names = await readdir(journalDir(root));
  } catch {
    return [];
  }
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map((name) => parse(join(journalDir(root), name))),
  );
  return records.filter((record): record is RunJournal => record !== undefined);
}

export async function removeJournal(root: string, taskId: string, runId: number): Promise<void> {
  await rm(journalPath(root, taskId, runId), { force: true });
}

async function parse(file: string): Promise<RunJournal | undefined> {
  try {
    const result = runJournalSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
