import { BoardError } from '../../src/core/errors.js';
import type { DocumentMeta, Report, Task } from '../../src/core/model/index.js';
import type { NewReport, NewTask, Storage, TaskPatch } from '../../src/core/ports.js';
import { isDocumentName } from '../../src/core/rules/documentName.js';
import { REPORT_ID_PREFIX, allocateId } from '../../src/core/rules/ids.js';

/**
 * The second implementation of the Storage port: it proves the port is an abstraction and
 * gives the core fast tests. It is not published and cannot be chosen by configuration.
 */
export interface MemoryStore {
  tasks: Map<string, Task>;
  documents: Map<string, Map<string, { content: string; updatedAt: string }>>;
  reports: Map<string, { report: Report; content: string }>;
  taskSequence: number;
  reportSequence: number;
}

export function createMemoryStore(): MemoryStore {
  return {
    tasks: new Map(),
    documents: new Map(),
    reports: new Map(),
    taskSequence: 0,
    reportSequence: 0,
  };
}

export function inMemoryStorage(store: MemoryStore, options: { idPrefix?: string } = {}): Storage {
  const idPrefix = options.idPrefix ?? 'T';
  const now = (): string => new Date().toISOString();

  function requireTask(id: string): Task {
    const task = store.tasks.get(id);
    if (!task) throw new BoardError('TASK_NOT_FOUND', `Task "${id}" does not exist.`, { id });
    return task;
  }

  function requireName(name: string): string {
    if (!isDocumentName(name)) {
      throw new BoardError('INVALID_DOCUMENT_NAME', `Invalid document name "${name}".`, { name });
    }
    return name;
  }

  function documentsOf(taskId: string): Map<string, { content: string; updatedAt: string }> {
    requireTask(taskId);
    const documents = store.documents.get(taskId) ?? new Map();
    store.documents.set(taskId, documents);
    return documents;
  }

  const meta = (
    taskId: string,
    name: string,
    content: string,
    updatedAt: string,
  ): DocumentMeta => ({
    taskId,
    name,
    size: Buffer.byteLength(content, 'utf8'),
    updatedAt,
  });

  return {
    init: async () => {},
    close: async () => {},

    listTasks: async () => [...store.tasks.values()],
    /** Memory cannot hold an unreadable task; the board it backs never has read problems. */
    readIssues: async () => [],
    getTask: async (id) => store.tasks.get(id) ?? null,

    createTask: async (input: NewTask) => {
      const { id, sequence } = allocateId(idPrefix, store.taskSequence, store.tasks.keys());
      store.taskSequence = sequence;
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
      store.tasks.set(id, task);
      return task;
    },

    updateTask: async (id, patch: TaskPatch) => {
      const task = requireTask(id);
      const { branch, ...rest } = patch;
      const updated: Task = { ...task, ...prune(rest), updatedAt: now() };
      if (branch === null) delete updated.branch;
      else if (branch !== undefined) updated.branch = branch;
      store.tasks.set(id, updated);
      return updated;
    },

    deleteTask: async (id) => {
      requireTask(id);
      store.tasks.delete(id);
      store.documents.delete(id);
    },

    listDocuments: async (taskId) =>
      [...documentsOf(taskId)]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, doc]) => meta(taskId, name, doc.content, doc.updatedAt)),

    readDocument: async (taskId, name) =>
      documentsOf(taskId).get(requireName(name))?.content ?? null,

    writeDocument: async (taskId, name, content) => {
      const documents = documentsOf(taskId);
      const updatedAt = now();
      documents.set(requireName(name), { content, updatedAt });
      return meta(taskId, name, content, updatedAt);
    },

    deleteDocument: async (taskId, name) => {
      const documents = documentsOf(taskId);
      if (!documents.delete(requireName(name))) {
        throw new BoardError('DOCUMENT_NOT_FOUND', `Document "${name}" does not exist.`, { name });
      }
    },

    listReports: async () => [...store.reports.values()].map((entry) => entry.report),
    readReport: async (id) => store.reports.get(id)?.content ?? null,

    writeReport: async (input: NewReport) => {
      const { id, sequence } = allocateId(
        REPORT_ID_PREFIX,
        store.reportSequence,
        store.reports.keys(),
      );
      store.reportSequence = sequence;
      const report: Report = {
        id,
        title: input.title,
        format: input.format,
        createdAt: now(),
      };
      store.reports.set(id, { report, content: input.content });
      return report;
    },

    deleteReport: async (id) => {
      if (!store.reports.delete(id)) {
        throw new BoardError('REPORT_NOT_FOUND', `Report "${id}" does not exist.`, { id });
      }
    },
  };
}

function prune<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
