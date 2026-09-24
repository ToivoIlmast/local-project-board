import type {
  BoardEvent,
  DocumentMeta,
  GitCommit,
  GitDiff,
  GitStatus,
  Project,
  Report,
  Task,
} from '../../../src/contract/v1/index';
import { rankForPosition } from '../../../src/core/rules/rank';
import { ApiError, type BoardClient } from '../../../src/web/api/index';
import { aGitStatus, aProject } from './fixtures';

export interface FakeBoardOptions {
  project?: Project;
  tasks?: Task[];
  reports?: Report[];
  git?: GitStatus;
  instructions?: string;
  commits?: GitCommit[];
  /** Documents already on the board, as an agent would have left them. */
  documents?: { taskId: string; name: string; content: string }[];
}

export interface FakeBoard {
  client: BoardClient;
  /** What the server would have published; delivered to whoever listens, as SSE does. */
  emit(event: BoardEvent): void;
  onEvent(listener: (event: BoardEvent) => void): () => void;
  calls: string[];
  tasks: Task[];
  reports: Report[];
  documents: Map<string, { meta: DocumentMeta; content: string }>;
  project: Project;
  git: GitStatus;
  /** Make the next call to one method fail, as a real board would. */
  fail(method: keyof BoardClient, error: ApiError): void;
  /** Hold the next call to one method open, to see what the page shows meanwhile. */
  hold(method: keyof BoardClient): () => void;
}

const NOW = '2026-09-22T10:00:00.000Z';

/**
 * The board as the page sees it, without HTTP: the same answers, the same events and the
 * same ranking rule the server uses, so a UI test is not testing a hand-made fantasy.
 */
export function fakeBoard(options: FakeBoardOptions = {}): FakeBoard {
  const project = options.project ?? aProject();
  const tasks: Task[] = [...(options.tasks ?? [])];
  const reports: Report[] = [...(options.reports ?? [])];
  const documents = new Map<string, { meta: DocumentMeta; content: string }>();
  const listeners: ((event: BoardEvent) => void)[] = [];
  const calls: string[] = [];
  const failures = new Map<string, ApiError>();
  const gates = new Map<string, Promise<void>>();
  let sequence = tasks.length;

  for (const seed of options.documents ?? []) {
    documents.set(`${seed.taskId}/${seed.name}`, {
      meta: { taskId: seed.taskId, name: seed.name, size: seed.content.length, updatedAt: NOW },
      content: seed.content,
    });
  }

  const emit = (event: BoardEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };

  async function record<T>(method: string, run: () => T | Promise<T>): Promise<T> {
    calls.push(method);
    const gate = gates.get(method);
    if (gate) {
      gates.delete(method);
      await gate;
    }
    const failure = failures.get(method);
    if (failure) {
      failures.delete(method);
      throw failure;
    }
    return await run();
  }

  const require = (id: string): Task => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task) throw new ApiError(404, 'TASK_NOT_FOUND', `Task "${id}" does not exist.`, { id });
    return task;
  };

  const key = (taskId: string, name: string): string => `${taskId}/${name}`;

  const client: BoardClient = {
    project: () => record('project', () => ({ ...project })),
    instructions: () => record('instructions', () => options.instructions ?? '# API\n'),
    session: () => record('session', () => 'fake-token'),

    listTasks: () => record('listTasks', () => tasks.map((task) => ({ ...task }))),
    getTask: (id) => record('getTask', () => ({ ...require(id) })),
    createTask: (input) =>
      record('createTask', () => {
        sequence += 1;
        const status = input.status ?? project.statuses[0] ?? 'todo';
        const task: Task = {
          id: `T${sequence}`,
          title: input.title,
          status,
          rank: rankForPosition(
            tasks.filter((candidate) => candidate.status === status),
            {},
          ),
          body: input.body ?? '',
          labels: input.labels ?? [],
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          createdAt: NOW,
          updatedAt: NOW,
        };
        tasks.push(task);
        emit({ type: 'task.created', task });
        return { ...task };
      }),
    updateTask: (id, patch) =>
      record('updateTask', () => {
        const task = require(id);
        const { branch, ...rest } = patch;
        Object.assign(task, rest, { updatedAt: NOW });
        if (branch === null) delete task.branch;
        else if (branch !== undefined) task.branch = branch;
        emit({ type: 'task.updated', task: { ...task } });
        return { ...task };
      }),
    moveTask: (id, move) =>
      record('moveTask', () => {
        const task = require(id);
        task.rank = rankForPosition(
          tasks.filter((candidate) => candidate.status === move.status),
          { after: move.after, before: move.before },
          id,
        );
        task.status = move.status;
        task.updatedAt = NOW;
        emit({ type: 'task.updated', task: { ...task } });
        return { ...task };
      }),
    deleteTask: (id) =>
      record('deleteTask', () => {
        require(id);
        tasks.splice(
          tasks.findIndex((task) => task.id === id),
          1,
        );
        emit({ type: 'task.deleted', taskId: id });
      }),

    listDocuments: (taskId) =>
      record('listDocuments', () =>
        [...documents.values()]
          .filter((document) => document.meta.taskId === taskId)
          .map((document) => ({ ...document.meta }))
          .sort((a, b) => (a.name < b.name ? -1 : 1)),
      ),
    readDocument: (taskId, name) =>
      record('readDocument', () => {
        const document = documents.get(key(taskId, name));
        if (!document) {
          throw new ApiError(404, 'DOCUMENT_NOT_FOUND', `Document "${name}" does not exist.`);
        }
        return document.content;
      }),
    writeDocument: (taskId, name, content) =>
      record('writeDocument', () => {
        const meta: DocumentMeta = { taskId, name, size: content.length, updatedAt: NOW };
        documents.set(key(taskId, name), { meta, content });
        emit({ type: 'document.written', document: meta });
        return { ...meta };
      }),
    deleteDocument: (taskId, name) =>
      record('deleteDocument', () => {
        documents.delete(key(taskId, name));
        emit({ type: 'document.deleted', taskId, name });
      }),

    listReports: () => record('listReports', () => reports.map((report) => ({ ...report }))),
    readReport: (id) =>
      record('readReport', () => {
        const report = reports.find((candidate) => candidate.id === id);
        if (!report) throw new ApiError(404, 'REPORT_NOT_FOUND', `Report "${id}" does not exist.`);
        return report.format === 'html' ? '<h1>Audit</h1>' : '# Audit\n';
      }),
    deleteReport: (id) =>
      record('deleteReport', () => {
        reports.splice(
          reports.findIndex((report) => report.id === id),
          1,
        );
        emit({ type: 'report.deleted', reportId: id });
      }),

    gitStatus: () => record('gitStatus', () => ({ ...(options.git ?? aGitStatus()) })),
    gitCommits: () => record('gitCommits', () => options.commits ?? ([] as GitCommit[])),
    gitDiff: () =>
      record('gitDiff', () => ({ text: '@@ -1 +1 @@\n-a\n+b\n', truncated: false }) as GitDiff),

    reportUrl: (id) => `/api/v1/reports/${id}`,
    documentUrl: (taskId, name) => `/api/v1/tasks/${taskId}/documents/${name}`,
    eventsUrl: () => '/api/v1/events',
  };

  return {
    client,
    emit,
    onEvent(listener) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    calls,
    tasks,
    reports,
    documents,
    project,
    git: options.git ?? aGitStatus(),
    fail: (method, error) => failures.set(method, error),
    hold(method) {
      let release = (): void => undefined;
      gates.set(method, new Promise<void>((resolve) => (release = resolve)));
      return release;
    },
  };
}
