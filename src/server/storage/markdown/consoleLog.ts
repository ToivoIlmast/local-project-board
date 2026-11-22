import { appendFile, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConsoleJournalEntry, ConsoleRunRef } from '../../../core/ports.js';

/**
 * The console journal of a run on disk (plan C7, §9.1): `console/<task id>-<runId>.ndjson` in
 * the board directory. The first line is a header, `{seq: 0, header}`, and every other line is
 * one entry. Append only: there is no function here that rewrites a line. The file is private to
 * the person (0600) and, being under `.board/`, untracked (ADR-0001).
 *
 * The callers hold the lock of the board's storage, so two appends never interleave; a torn last
 * line (the process died mid-write) is closed by a line break before the next append and left
 * out of every read.
 */
export interface ConsoleFiles {
  append(run: ConsoleRunRef, entries: readonly ConsoleJournalEntry[]): Promise<void>;
  read(taskId: string, runId: number): Promise<ConsoleJournalEntry[]>;
  /** Removes the journals of every run of a task, as the task is deleted. */
  removeTask(taskId: string): Promise<void>;
}

const FORMAT_VERSION = 1;
const PRIVATE = 0o600;

export function consoleFiles(options: { dir: string }): ConsoleFiles {
  const fileOf = (taskId: string, runId: number): string =>
    join(options.dir, `${taskId}-${runId}.ndjson`);

  const lines = (entries: readonly ConsoleJournalEntry[]): string =>
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');

  /** The size of the file and whether it ends a line; null when there is no such file. */
  async function tail(file: string): Promise<{ size: number; closed: boolean } | null> {
    let handle;
    try {
      handle = await open(file, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return { size, closed: true };
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      return { size, closed: last[0] === 0x0a };
    } finally {
      await handle.close();
    }
  }

  return {
    async append(run, entries) {
      if (entries.length === 0) return;
      const file = fileOf(run.taskId, run.runId);
      await mkdir(options.dir, { recursive: true });
      const found = await tail(file);
      if (found === null || found.size === 0) {
        const header = {
          seq: 0,
          header: {
            formatVersion: FORMAT_VERSION,
            taskId: run.taskId,
            runId: run.runId,
            sessionId: run.sessionId,
          },
        };
        await writeFile(file, `${JSON.stringify(header)}\n${lines(entries)}`, {
          encoding: 'utf8',
          mode: PRIVATE,
        });
        return;
      }
      await appendFile(file, `${found.closed ? '' : '\n'}${lines(entries)}`, 'utf8');
    },

    async read(taskId, runId) {
      let text: string;
      try {
        text = await readFile(fileOf(taskId, runId), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const entries: ConsoleJournalEntry[] = [];
      for (const line of text.split('\n')) {
        if (line === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (isEntry(parsed)) entries.push(parsed);
      }
      return entries;
    },

    async removeTask(taskId) {
      let names: string[];
      try {
        names = await readdir(options.dir);
      } catch {
        return;
      }
      const prefix = `${taskId}-`;
      await Promise.all(
        names
          .filter(
            (name) => name.startsWith(prefix) && /^\d+\.ndjson$/.test(name.slice(prefix.length)),
          )
          .map((name) => rm(join(options.dir, name), { force: true })),
      );
    },
  };
}

/** What a line must be to count as an entry; the header and anything else is not one. */
function isEntry(value: unknown): value is ConsoleJournalEntry {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  const event = item['event'];
  return (
    Number.isInteger(item['seq']) &&
    (item['seq'] as number) >= 1 &&
    typeof item['at'] === 'string' &&
    (item['source'] === 'runner' || item['source'] === 'server') &&
    (item['runnerSeq'] === undefined || Number.isInteger(item['runnerSeq'])) &&
    typeof event === 'object' &&
    event !== null &&
    typeof (event as Record<string, unknown>)['kind'] === 'string'
  );
}
