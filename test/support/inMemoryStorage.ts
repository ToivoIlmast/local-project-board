import { BoardError } from '../../src/core/errors.js';
import type {
  CheckBegin,
  CheckEnd,
  CheckReport,
  Decision,
  DocumentMeta,
  Report,
  Task,
  TaskVersion,
  WorkflowOverrides,
} from '../../src/core/model/index.js';
import type { NewReport, NewTask, Storage, TaskPatch } from '../../src/core/ports.js';
import { isDocumentName } from '../../src/core/rules/documentName.js';
import { assembleCheck } from '../../src/core/rules/history.js';
import { REPORT_ID_PREFIX, allocateId } from '../../src/core/rules/ids.js';

/**
 * The second implementation of the Storage port: it proves the port is an abstraction and
 * gives the core fast tests. It is not published and cannot be chosen by configuration.
 */
export interface MemoryStore {
  tasks: Map<string, Task>;
  documents: Map<string, Map<string, { content: string; updatedAt: string }>>;
  reports: Map<string, { report: Report; content: string }>;
  /** The history of each task, as the records the markdown provider keeps in files. */
  history: Map<string, MemoryHistory>;
  workflow: WorkflowOverrides;
  taskSequence: number;
  reportSequence: number;
}

export interface MemoryHistory {
  versions: TaskVersion[];
  checks: Map<
    number,
    { begin: CheckBegin; report?: CheckReport; end?: CheckEnd; decisions: Decision[] }
  >;
}

export function createMemoryStore(): MemoryStore {
  return {
    history: new Map(),
    tasks: new Map(),
    documents: new Map(),
    reports: new Map(),
    workflow: { board: {}, statuses: {} },
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

  function historyOf(taskId: string): MemoryHistory {
    requireTask(taskId);
    const history = store.history.get(taskId) ?? { versions: [], checks: new Map() };
    store.history.set(taskId, history);
    return history;
  }

  function requireCheckRecord(
    taskId: string,
    number: number,
  ): MemoryHistory['checks'] extends Map<number, infer R> ? R : never {
    const check = historyOf(taskId).checks.get(number);
    if (check === undefined) {
      throw new BoardError('CHECK_NOT_FOUND', `Task "${taskId}" has no check ${number}.`, {
        id: taskId,
        check: number,
      });
    }
    return check;
  }

  function alreadyFinal(taskId: string, number: number): BoardError {
    return new BoardError(
      'CHECK_ALREADY_FINAL',
      `Check ${number} of task "${taskId}" cannot take this.`,
      { id: taskId, check: number },
    );
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
        ...(input.workflow === undefined ? {} : { workflow: { ...input.workflow } }),
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.extra === undefined ? {} : { extra: { ...input.extra } }),
      };
      store.tasks.set(id, task);
      return task;
    },

    updateTask: async (id, patch: TaskPatch) => {
      const task = requireTask(id);
      const { branch, workflow, aiRun, ...rest } = patch;
      const updated: Task = { ...task, ...prune(rest), updatedAt: now() };
      if (branch === null) delete updated.branch;
      else if (branch !== undefined) updated.branch = branch;
      if (workflow === null) delete updated.workflow;
      else if (workflow !== undefined) updated.workflow = { ...workflow };
      if (aiRun === null) delete updated.aiRun;
      else if (aiRun !== undefined) updated.aiRun = { ...aiRun };
      store.tasks.set(id, updated);
      return updated;
    },

    readWorkflow: async () => structuredClone(store.workflow),
    writeWorkflow: async (workflow) => {
      store.workflow = structuredClone(workflow);
    },

    deleteTask: async (id) => {
      requireTask(id);
      store.tasks.delete(id);
      store.documents.delete(id);
      store.history.delete(id);
    },

    appendVersion: async (taskId, input) => {
      const history = historyOf(taskId);
      const number = Math.max(0, ...history.versions.map((version) => version.number)) + 1;
      const version: TaskVersion = {
        taskId,
        number,
        createdAt: input.createdAt ?? now(),
        source: input.source,
        changed: [...input.changed],
        snapshot: structuredClone(input.snapshot),
        ...(input.restoredFrom === undefined ? {} : { restoredFrom: input.restoredFrom }),
        ...(input.fromCheck === undefined ? {} : { fromCheck: structuredClone(input.fromCheck) }),
      };
      history.versions.push(version);
      return structuredClone(version);
    },
    listVersions: async (taskId) => structuredClone(historyOf(taskId).versions),
    readVersion: async (taskId, number) =>
      structuredClone(historyOf(taskId).versions.find((v) => v.number === number) ?? null),

    beginCheck: async (taskId, input) => {
      const history = historyOf(taskId);
      const number = Math.max(0, ...history.checks.keys()) + 1;
      const begin: CheckBegin = {
        taskId,
        number,
        version: input.version,
        createdAt: input.createdAt ?? now(),
        agent: input.agent,
        sessionId: input.sessionId,
        ...(input.model === undefined ? {} : { model: input.model }),
        repo: input.repo,
      };
      history.checks.set(number, { begin, decisions: [] });
      return structuredClone(begin);
    },
    writeCheckReport: async (taskId, number, input) => {
      const check = requireCheckRecord(taskId, number);
      if (check.report !== undefined || check.end !== undefined) throw alreadyFinal(taskId, number);
      const { createdAt, ...content } = input;
      check.report = structuredClone({
        ...content,
        taskId,
        check: number,
        createdAt: createdAt ?? now(),
      });
      return structuredClone(check.report);
    },
    endCheck: async (taskId, number, input) => {
      const check = requireCheckRecord(taskId, number);
      if (check.end !== undefined) throw alreadyFinal(taskId, number);
      check.end = {
        taskId,
        check: number,
        sessionId: input.sessionId,
        ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
        endedAt: input.endedAt ?? now(),
      };
      return structuredClone(check.end);
    },
    listChecks: async (taskId) =>
      [...historyOf(taskId).checks.values()]
        .map((check) => assembleCheck(structuredClone(check)))
        .sort((a, b) => a.begin.number - b.begin.number),
    readCheck: async (taskId, number) => {
      const check = historyOf(taskId).checks.get(number);
      return check === undefined ? null : assembleCheck(structuredClone(check));
    },
    appendDecision: async (taskId, number, input) => {
      const check = requireCheckRecord(taskId, number);
      const decision: Decision = {
        taskId,
        check: number,
        number: Math.max(0, ...check.decisions.map((d) => d.number)) + 1,
        recommendation: input.recommendation,
        decision: input.decision,
        ...(input.note === undefined ? {} : { note: input.note }),
        createdAt: input.createdAt ?? now(),
      };
      check.decisions.push(decision);
      return structuredClone(decision);
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
