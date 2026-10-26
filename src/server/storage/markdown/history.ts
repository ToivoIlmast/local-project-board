import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import { BoardError } from '../../../core/errors.js';
import {
  checkBeginSchema,
  checkEndSchema,
  checkReportSchema,
  decisionSchema,
  taskVersionSchema,
  type Check,
  type CheckBegin,
  type CheckEnd,
  type CheckReport,
  type Decision,
  type TaskVersion,
} from '../../../core/model/index.js';
import type {
  NewCheckBegin,
  NewCheckEnd,
  NewCheckReport,
  NewDecision,
  NewVersion,
  ReadIssue,
} from '../../../core/ports.js';
import { assembleCheck, storedCheckReport } from '../../../core/rules/history.js';

/**
 * The history of a task on disk (ADR-0030 §2), under `tasks/<id>/history/`:
 *
 *     versions/<n>.json
 *     checks/<n>.begin.json  <n>.report.json  <n>.end.json  <n>.decisions/<k>.json
 *     checks/<n>.report.md   (a research only; written before its <n>.report.json, ADR-0030 R3)
 *
 * Every file is created once, exclusively (`wx`), and never rewritten or removed; there is no
 * function here that does either. A number is the highest one that exists plus one, counting a
 * file that cannot be read too, so a broken file is never written over. The callers hold the
 * lock of the board's storage; `wx` is the second line of defence against a rewrite.
 */
export interface HistoryFiles {
  appendVersion(taskId: string, input: NewVersion): Promise<TaskVersion>;
  listVersions(taskId: string): Promise<TaskVersion[]>;
  readVersion(taskId: string, number: number): Promise<TaskVersion | null>;
  beginCheck(taskId: string, input: NewCheckBegin): Promise<CheckBegin>;
  writeCheckReport(taskId: string, number: number, input: NewCheckReport): Promise<CheckReport>;
  endCheck(taskId: string, number: number, input: NewCheckEnd): Promise<CheckEnd>;
  listChecks(taskId: string): Promise<Check[]>;
  readCheck(taskId: string, number: number): Promise<Check | null>;
  readCheckMarkdown(taskId: string, number: number): Promise<string | null>;
  appendDecision(taskId: string, number: number, input: NewDecision): Promise<Decision>;
  /** What in the history of a task cannot be read, as files relative to the board directory. */
  issues(taskId: string): Promise<ReadIssue[]>;
}

type Read<T> = { value: T } | { error: string } | null;

export function historyFiles(options: {
  /** The directory of a task; the caller has checked that the id is one. */
  taskDir: (taskId: string) => string;
  now: () => string;
}): HistoryFiles {
  const historyDir = (taskId: string): string => join(options.taskDir(taskId), 'history');
  const versionsDir = (taskId: string): string => join(historyDir(taskId), 'versions');
  const checksDir = (taskId: string): string => join(historyDir(taskId), 'checks');
  const versionFile = (taskId: string, number: number): string =>
    join(versionsDir(taskId), `${number}.json`);
  const checkFile = (taskId: string, number: number, part: 'begin' | 'report' | 'end'): string =>
    join(checksDir(taskId), `${number}.${part}.json`);
  const markdownFile = (taskId: string, number: number): string =>
    join(checksDir(taskId), `${number}.report.md`);
  const decisionsDir = (taskId: string, number: number): string =>
    join(checksDir(taskId), `${number}.decisions`);

  /** Every number used by a name in the directory, a name that does not parse included. */
  async function highest(dir: string): Promise<number> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return 0;
    }
    return names.reduce((max, name) => {
      const number = /^(\d+)(?:\.|$)/.exec(name)?.[1];
      return number === undefined ? max : Math.max(max, Number(number));
    }, 0);
  }

  async function names(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  }

  async function exists(file: string): Promise<boolean> {
    try {
      await readFile(file);
      return true;
    } catch {
      return false;
    }
  }

  async function readRecord<S extends z.ZodType>(
    file: string,
    schema: S,
  ): Promise<Read<z.infer<S>>> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return { error: `The file cannot be read: ${(error as Error).message}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { error: `Invalid JSON: ${(error as Error).message}` };
    }
    const result = schema.safeParse(parsed);
    if (result.success) return { value: result.data };
    const issue = result.error.issues[0];
    return { error: `${issue?.path.join('.') ?? 'record'}: ${issue?.message ?? 'invalid'}` };
  }

  /** Created once. A second creation of the same file is a refusal, never an overwrite. */
  async function createOnce(file: string, record: unknown): Promise<'created' | 'exists'> {
    await mkdir(join(file, '..'), { recursive: true });
    try {
      await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      return 'created';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw error;
    }
  }

  /** Created once, byte for byte; an existing file is left as it is and `exists` is answered. */
  async function createTextOnce(file: string, text: string): Promise<'created' | 'exists'> {
    await mkdir(join(file, '..'), { recursive: true });
    try {
      await writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
      return 'created';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw error;
    }
  }

  function checkNotFound(taskId: string, number: number): BoardError {
    return new BoardError('CHECK_NOT_FOUND', `Task "${taskId}" has no check ${number}.`, {
      id: taskId,
      check: number,
    });
  }

  function alreadyFinal(taskId: string, number: number): BoardError {
    return new BoardError(
      'CHECK_ALREADY_FINAL',
      `Check ${number} of task "${taskId}" cannot take this: it has a report or an end already.`,
      { id: taskId, check: number },
    );
  }

  /** A record that was just made must be a record the reader accepts; a bug is not stored. */
  function made<S extends z.ZodType>(schema: S, record: unknown): z.infer<S> {
    return schema.parse(record);
  }

  async function requireBegin(taskId: string, number: number): Promise<CheckBegin> {
    const begin = await readRecord(checkFile(taskId, number, 'begin'), checkBeginSchema);
    if (begin === null || 'error' in begin) throw checkNotFound(taskId, number);
    return begin.value;
  }

  async function decisionsOf(taskId: string, number: number): Promise<Decision[]> {
    const dir = decisionsDir(taskId, number);
    const found: Decision[] = [];
    for (const name of await names(dir)) {
      if (!/^\d+\.json$/.test(name)) continue;
      const read = await readRecord(join(dir, name), decisionSchema);
      if (read !== null && 'value' in read) found.push(read.value);
    }
    return found;
  }

  async function readCheckOf(taskId: string, number: number): Promise<Check | null> {
    const begin = await readRecord(checkFile(taskId, number, 'begin'), checkBeginSchema);
    if (begin === null || 'error' in begin) return null;
    const report = await readRecord(checkFile(taskId, number, 'report'), checkReportSchema);
    const end = await readRecord(checkFile(taskId, number, 'end'), checkEndSchema);
    return assembleCheck({
      begin: begin.value,
      report: report !== null && 'value' in report ? report.value : undefined,
      end: end !== null && 'value' in end ? end.value : undefined,
      decisions: await decisionsOf(taskId, number),
    });
  }

  return {
    async appendVersion(taskId, input) {
      const number = (await highest(versionsDir(taskId))) + 1;
      const version = made(taskVersionSchema, {
        taskId,
        number,
        createdAt: input.createdAt ?? options.now(),
        source: input.source,
        changed: input.changed,
        snapshot: input.snapshot,
        ...(input.restoredFrom === undefined ? {} : { restoredFrom: input.restoredFrom }),
        ...(input.fromCheck === undefined ? {} : { fromCheck: input.fromCheck }),
      });
      if ((await createOnce(versionFile(taskId, number), version)) === 'exists') {
        throw new Error(`Version ${number} of task ${taskId} exists already; it is not rewritten.`);
      }
      return version;
    },

    async listVersions(taskId) {
      const found: TaskVersion[] = [];
      for (const name of await names(versionsDir(taskId))) {
        const number = /^(\d+)\.json$/.exec(name)?.[1];
        if (number === undefined) continue;
        const read = await readRecord(join(versionsDir(taskId), name), taskVersionSchema);
        if (read !== null && 'value' in read && read.value.number === Number(number)) {
          found.push(read.value);
        }
      }
      return found.sort((a, b) => a.number - b.number);
    },

    async readVersion(taskId, number) {
      const read = await readRecord(versionFile(taskId, number), taskVersionSchema);
      return read !== null && 'value' in read && read.value.number === number ? read.value : null;
    },

    async beginCheck(taskId, input) {
      const number = (await highest(checksDir(taskId))) + 1;
      const begin = made(checkBeginSchema, {
        taskId,
        number,
        version: input.version,
        createdAt: input.createdAt ?? options.now(),
        agent: input.agent,
        sessionId: input.sessionId,
        ...(input.model === undefined ? {} : { model: input.model }),
        repo: input.repo,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.comment === undefined ? {} : { comment: input.comment }),
        ...(input.documents === undefined ? {} : { documents: input.documents }),
      });
      if ((await createOnce(checkFile(taskId, number, 'begin'), begin)) === 'exists') {
        throw new Error(`Check ${number} of task ${taskId} exists already; it is not rewritten.`);
      }
      return begin;
    },

    async writeCheckReport(taskId, number, input) {
      const begin = await requireBegin(taskId, number);
      // A check that has a report or an end takes no report: it is no longer working.
      if (await exists(checkFile(taskId, number, 'end'))) throw alreadyFinal(taskId, number);
      const { report, markdown } = storedCheckReport(begin, {
        ...input,
        createdAt: input.createdAt ?? options.now(),
      });
      if (markdown !== undefined) {
        // The record decides whether there is a report; look before the text is touched.
        if (await exists(checkFile(taskId, number, 'report'))) throw alreadyFinal(taskId, number);
        // The text first (R3). One that is there already may be the half of an earlier try:
        // the same bytes continue it, other bytes are refused and nothing is replaced.
        const file = markdownFile(taskId, number);
        if ((await createTextOnce(file, markdown)) === 'exists') {
          const written = await readFile(file);
          if (!written.equals(Buffer.from(markdown, 'utf8'))) throw alreadyFinal(taskId, number);
        }
      }
      if ((await createOnce(checkFile(taskId, number, 'report'), report)) === 'exists') {
        throw alreadyFinal(taskId, number);
      }
      return report;
    },

    async endCheck(taskId, number, input) {
      await requireBegin(taskId, number);
      const end = made(checkEndSchema, {
        taskId,
        check: number,
        sessionId: input.sessionId,
        ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
        endedAt: input.endedAt ?? options.now(),
        ...(input.repo === undefined ? {} : { repo: input.repo }),
      });
      if ((await createOnce(checkFile(taskId, number, 'end'), end)) === 'exists') {
        throw alreadyFinal(taskId, number);
      }
      return end;
    },

    async listChecks(taskId) {
      const numbers = new Set<number>();
      for (const name of await names(checksDir(taskId))) {
        const number = /^(\d+)\.begin\.json$/.exec(name)?.[1];
        if (number !== undefined) numbers.add(Number(number));
      }
      const checks = await Promise.all([...numbers].map((number) => readCheckOf(taskId, number)));
      return checks
        .filter((check): check is Check => check !== null)
        .sort((a, b) => a.begin.number - b.begin.number);
    },

    readCheck: (taskId, number) => readCheckOf(taskId, number),

    async readCheckMarkdown(taskId, number) {
      const report = await readRecord(checkFile(taskId, number, 'report'), checkReportSchema);
      const described = report !== null && 'value' in report ? report.value.markdown : undefined;
      if (described === undefined) return null;
      try {
        const text = await readFile(markdownFile(taskId, number), 'utf8');
        return Buffer.byteLength(text, 'utf8') === described.bytes ? text : null;
      } catch {
        return null;
      }
    },

    async appendDecision(taskId, number, input) {
      await requireBegin(taskId, number);
      const dir = decisionsDir(taskId, number);
      const next = (await highest(dir)) + 1;
      const decision = made(decisionSchema, {
        taskId,
        check: number,
        number: next,
        recommendation: input.recommendation,
        decision: input.decision,
        ...(input.note === undefined ? {} : { note: input.note }),
        createdAt: input.createdAt ?? options.now(),
      });
      if ((await createOnce(join(dir, `${next}.json`), decision)) === 'exists') {
        throw new Error(`Decision ${next} of check ${number} exists already; it is not rewritten.`);
      }
      return decision;
    },

    async issues(taskId) {
      const issues: ReadIssue[] = [];
      const relative = (...parts: string[]): string =>
        ['tasks', taskId, 'history', ...parts].join('/');
      const note = (file: string, read: Read<unknown>): void => {
        if (read !== null && 'error' in read) issues.push({ file, message: read.error });
      };

      for (const name of await names(versionsDir(taskId))) {
        const number = /^(\d+)\.json$/.exec(name)?.[1];
        if (number === undefined) continue;
        const read = await readRecord(join(versionsDir(taskId), name), taskVersionSchema);
        note(relative('versions', name), read);
        if (read !== null && 'value' in read && read.value.number !== Number(number)) {
          issues.push({
            file: relative('versions', name),
            message: `The file holds version ${read.value.number}, not ${number}.`,
          });
        }
      }

      const parts = {
        begin: checkBeginSchema,
        report: checkReportSchema,
        end: checkEndSchema,
      } as const;
      for (const name of await names(checksDir(taskId))) {
        const match = /^(\d+)\.(begin|report|end)\.json$/.exec(name);
        if (match?.[2] === undefined) continue;
        const schema = parts[match[2] as keyof typeof parts];
        const read = await readRecord(join(checksDir(taskId), name), schema);
        note(relative('checks', name), read);
        // A record that describes a markdown vouches for a file by its size alone: the text is
        // not read here. A markdown with no record is a half-written report, not an issue.
        const described =
          match[2] === 'report' && read !== null && 'value' in read
            ? (read.value as CheckReport).markdown
            : undefined;
        if (described !== undefined) {
          const file = `${match[1]}.report.md`;
          const size = await stat(join(checksDir(taskId), file)).then(
            (info) => info.size,
            () => null,
          );
          if (size !== described.bytes) {
            issues.push({
              file: relative('checks', file),
              message:
                size === null
                  ? 'The markdown named by its report is missing.'
                  : `The markdown is ${size} bytes, its report says ${described.bytes}.`,
            });
          }
        }
      }
      for (const name of await names(checksDir(taskId))) {
        const number = /^(\d+)\.decisions$/.exec(name)?.[1];
        if (number === undefined) continue;
        const dir = join(checksDir(taskId), name);
        for (const file of await names(dir)) {
          if (!/^\d+\.json$/.test(file)) continue;
          note(relative('checks', name, file), await readRecord(join(dir, file), decisionSchema));
        }
      }
      return issues;
    },
  };
}
