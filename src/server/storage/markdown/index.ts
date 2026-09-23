import { mkdir, readFile, readdir, rm, stat, watch, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BoardError } from '../../../core/errors.js';
import type { DocumentMeta, Report, Task } from '../../../core/model/index.js';
import type { NewReport, NewTask, Storage, TaskPatch } from '../../../core/ports.js';
import { documentFormat, isDocumentName } from '../../../core/rules/documentName.js';
import { REPORT_ID_PREFIX, allocateId, isReportId, isTaskId } from '../../../core/rules/ids.js';
import { writeFileAtomic } from './atomic.js';
import { parseTask, serializeTask } from './taskFile.js';

export interface StorageIssue {
  file: string;
  message: string;
}

export interface MarkdownStorageOptions {
  /** The board root; the board itself lives in <root>/.board. */
  root: string;
  idPrefix?: string | undefined;
  /** Called when something on disk cannot be read as a task, instead of failing the request. */
  onIssue?: ((issue: StorageIssue) => void) | undefined;
  /** Called when the board changed outside the server; drives live updates, never correctness. */
  onExternalChange?: (() => void) | undefined;
}

interface BoardState {
  formatVersion: 1;
  taskSequence: number;
  reportSequence: number;
}

const STATE_FILE = 'board.json';
const TASK_FILE = 'task.md';

/**
 * The default provider and the source of truth (ADR-0002). Every read goes to disk
 * (ADR-0019); the watcher only tells open clients that something changed.
 */
export function markdownStorage(options: MarkdownStorageOptions): Storage {
  const boardDir = join(options.root, '.board');
  const tasksDir = join(boardDir, 'tasks');
  const reportsDir = join(boardDir, 'reports');
  const idPrefix = options.idPrefix ?? 'T';
  const now = (): string => new Date().toISOString();

  /** One board, one process (a second server is refused): a promise chain is lock enough. */
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action, action);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  let watcher: AbortController | undefined;

  const taskDir = (id: string): string => join(tasksDir, requireTaskId(id));

  function requireTaskId(id: string): string {
    if (!isTaskId(id)) throw notFound(id);
    return id;
  }

  function notFound(id: string): BoardError {
    return new BoardError('TASK_NOT_FOUND', `Task "${id}" does not exist.`, { id });
  }

  function requireName(name: string): string {
    if (!isDocumentName(name)) {
      throw new BoardError('INVALID_DOCUMENT_NAME', `Invalid document name "${name}".`, { name });
    }
    return name;
  }

  async function readState(): Promise<BoardState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(boardDir, STATE_FILE), 'utf8'));
      const state = parsed as Partial<BoardState>;
      return {
        formatVersion: 1,
        taskSequence: Number(state.taskSequence) || 0,
        reportSequence: Number(state.reportSequence) || 0,
      };
    } catch {
      return { formatVersion: 1, taskSequence: 0, reportSequence: 0 };
    }
  }

  async function writeState(state: BoardState): Promise<void> {
    await writeFileAtomic(join(boardDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
  }

  async function taskIds(): Promise<string[]> {
    const entries = await readdir(tasksDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && isTaskId(entry.name))
      .map((e) => e.name);
  }

  async function loadTask(id: string): Promise<Task | null> {
    const file = join(tasksDir, id, TASK_FILE);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return null;
    }
    const result = parseTask(id, text);
    if ('error' in result) {
      options.onIssue?.({ file, message: result.error });
      return null;
    }
    return result.task;
  }

  async function requireTask(id: string): Promise<Task> {
    const task = await loadTask(requireTaskId(id));
    if (!task) throw notFound(id);
    return task;
  }

  async function saveTask(task: Task): Promise<Task> {
    await writeFileAtomic(join(taskDir(task.id), TASK_FILE), serializeTask(task));
    return task;
  }

  async function documentMeta(taskId: string, name: string): Promise<DocumentMeta> {
    const info = await stat(join(taskDir(taskId), name));
    return { taskId, name, size: info.size, updatedAt: info.mtime.toISOString() };
  }

  async function readReportMeta(id: string): Promise<Report | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(reportsDir, `${id}.json`), 'utf8'));
      return parsed as Report;
    } catch {
      return null;
    }
  }

  return {
    async init() {
      await mkdir(tasksDir, { recursive: true });
      await mkdir(reportsDir, { recursive: true });
      // The board ignores itself, so no project has to know about it (ADR-0001).
      await writeFile(join(boardDir, '.gitignore'), '*\n', { encoding: 'utf8' });
      if (options.onExternalChange && !watcher) watcher = startWatching(boardDir, options);
    },

    async close() {
      watcher?.abort();
      watcher = undefined;
      await queue.catch(() => undefined);
    },

    async listTasks() {
      const ids = (await taskIds()).sort(byNumber);
      const tasks = await Promise.all(ids.map(loadTask));
      return tasks.filter((task): task is Task => task !== null);
    },

    async getTask(id) {
      return isTaskId(id) ? loadTask(id) : null;
    },

    createTask(input: NewTask) {
      return exclusive(async () => {
        const state = await readState();
        const { id, sequence } = allocateId(idPrefix, state.taskSequence, await taskIds());
        const timestamp = now();
        const task: Task = {
          id,
          title: input.title,
          status: input.status,
          rank: input.rank,
          body: input.body,
          labels: [...input.labels],
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          createdAt: timestamp,
          updatedAt: timestamp,
          ...(input.extra === undefined ? {} : { extra: { ...input.extra } }),
        };
        await mkdir(join(tasksDir, id), { recursive: true });
        await saveTask(task);
        await writeState({ ...state, taskSequence: sequence });
        return task;
      });
    },

    updateTask(id, patch: TaskPatch) {
      return exclusive(async () => {
        const task = await requireTask(id);
        const { branch, ...rest } = patch;
        const updated: Task = { ...task, ...prune(rest), updatedAt: now() };
        if (branch === null) delete updated.branch;
        else if (branch !== undefined) updated.branch = branch;
        return saveTask(updated);
      });
    },

    deleteTask(id) {
      return exclusive(async () => {
        await requireTask(id);
        await rm(taskDir(id), { recursive: true, force: true });
      });
    },

    async listDocuments(taskId) {
      await requireTask(taskId);
      const entries = await readdir(taskDir(taskId), { withFileTypes: true });
      const names = entries
        .filter((entry) => entry.isFile() && isDocumentName(entry.name))
        .map((entry) => entry.name)
        .sort();
      return Promise.all(names.map((name) => documentMeta(taskId, name)));
    },

    async readDocument(taskId, name) {
      requireName(name);
      await requireTask(taskId);
      try {
        return await readFile(join(taskDir(taskId), name), 'utf8');
      } catch {
        return null;
      }
    },

    writeDocument(taskId, name, content) {
      return exclusive(async () => {
        requireName(name);
        await requireTask(taskId);
        await writeFileAtomic(join(taskDir(taskId), name), content);
        return documentMeta(taskId, name);
      });
    },

    deleteDocument(taskId, name) {
      return exclusive(async () => {
        requireName(name);
        await requireTask(taskId);
        try {
          await rm(join(taskDir(taskId), name), { force: false });
        } catch {
          throw new BoardError('DOCUMENT_NOT_FOUND', `Document "${name}" does not exist.`, {
            taskId,
            name,
          });
        }
      });
    },

    async listReports() {
      const entries = await readdir(reportsDir, { withFileTypes: true });
      const ids = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name.slice(0, -'.json'.length))
        .filter(isReportId)
        .sort(byNumber);
      const reports = await Promise.all(ids.map(readReportMeta));
      return reports.filter((report): report is Report => report !== null);
    },

    async readReport(id) {
      const report = isReportId(id) ? await readReportMeta(id) : null;
      if (!report) return null;
      try {
        return await readFile(join(reportsDir, `${id}.${report.format}`), 'utf8');
      } catch {
        return null;
      }
    },

    writeReport(input: NewReport) {
      return exclusive(async () => {
        const state = await readState();
        const existing = (await readdir(reportsDir)).map((name) => name.replace(/\.[^.]+$/, ''));
        const { id, sequence } = allocateId(REPORT_ID_PREFIX, state.reportSequence, existing);
        const report: Report = {
          id,
          title: input.title,
          format: input.format,
          createdAt: now(),
        };
        await writeFileAtomic(join(reportsDir, `${id}.${input.format}`), input.content);
        await writeFileAtomic(
          join(reportsDir, `${id}.json`),
          `${JSON.stringify(report, null, 2)}\n`,
        );
        await writeState({ ...state, reportSequence: sequence });
        return report;
      });
    },

    deleteReport(id) {
      return exclusive(async () => {
        const report = isReportId(id) ? await readReportMeta(id) : null;
        if (!report) {
          throw new BoardError('REPORT_NOT_FOUND', `Report "${id}" does not exist.`, { id });
        }
        await rm(join(reportsDir, `${id}.${documentFormat(`x.${report.format}`)}`), {
          force: true,
        });
        await rm(join(reportsDir, `${id}.json`), { force: true });
      });
    },
  };
}

function startWatching(boardDir: string, options: MarkdownStorageOptions): AbortController {
  const controller = new AbortController();
  void (async () => {
    try {
      let pending: NodeJS.Timeout | undefined;
      for await (const _event of watch(boardDir, {
        recursive: true,
        signal: controller.signal,
      })) {
        if (pending) clearTimeout(pending);
        // Several writes arrive as several events; one refresh is enough.
        pending = setTimeout(() => options.onExternalChange?.(), 50);
        pending.unref();
      }
    } catch {
      // Watching is best-effort: it does not work on WSL2 for /mnt/c paths (ADR-0019).
    }
  })();
  return controller;
}

function byNumber(a: string, b: string): number {
  const digits = (value: string): number => Number(/\d+$/.exec(value)?.[0] ?? 0);
  return digits(a) - digits(b);
}

/** Drops the keys a patch did not set, so `undefined` never overwrites a stored value. */
function prune<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
