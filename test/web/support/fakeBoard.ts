import type {
  BoardEvent,
  Check,
  Decision,
  DocumentMeta,
  EffectiveWorkflow,
  GitCommit,
  GitDiff,
  GitStatus,
  Project,
  Report,
  RunTaskRequest,
  Task,
  TaskVersion,
  VersionList,
  WorkflowOverrides,
  WorkflowState,
} from '../../../src/contract/v1/index';
import {
  changedFields,
  contentHash,
  contentOf,
  generateHandoff,
  latestDecisions,
  sameContent,
  summarizeCheck,
} from '../../../src/contract/v1/index';
import { rankForPosition } from '../../../src/core/rules/rank';
import { defaultWorkflow, resolveWorkflow } from '../../../src/core/rules/workflow';
import { ApiError, type BoardClient } from '../../../src/web/api/index';
import { aGitStatus, aProject } from './fixtures';

export interface FakeBoardOptions {
  project?: Project;
  tasks?: Task[];
  reports?: Report[];
  git?: GitStatus;
  /** The overrides the board already has; none by default. */
  workflow?: WorkflowOverrides;
  instructions?: string;
  commits?: GitCommit[];
  /** Documents already on the board, as an agent would have left them. */
  documents?: { taskId: string; name: string; content: string }[];
  /** Versions a task already has; its history is kept, as the server keeps it. */
  versions?: Record<string, Omit<TaskVersion, 'taskId' | 'number' | 'createdAt'>[]>;
  /** Checks a task already has, with their reports and decisions. */
  checks?: Record<string, Check[]>;
  /** The markdown of each research report, by `<task>/<number>`. */
  researchMarkdown?: Record<string, string>;
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
  /** The overrides of the board and its columns, as the server would store them. */
  workflow: WorkflowOverrides;
  /** What was handed to a waiting runner, oldest first: the board of these tests always has one. */
  runs: ({ taskId: string } & RunTaskRequest)[];
  /** Every change of a task the page asked for, as it was sent: only the fields it carried. */
  patches: { id: string; patch: Record<string, unknown> }[];
  /** The versions and the checks of each task, as the board holds them. */
  versions: Map<string, TaskVersion[]>;
  checks: Map<string, Check[]>;
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
  const overrides: WorkflowOverrides = structuredClone(
    options.workflow ?? { board: {}, statuses: {} },
  );
  const listeners: ((event: BoardEvent) => void)[] = [];
  const calls: string[] = [];
  const runs: ({ taskId: string } & RunTaskRequest)[] = [];
  const versions = new Map<string, TaskVersion[]>();
  const checks = new Map<string, Check[]>(
    Object.entries(options.checks ?? {}).map(([id, list]) => [id, structuredClone(list)]),
  );
  const patches: { id: string; patch: Record<string, unknown> }[] = [];
  const failures = new Map<string, ApiError>();
  const gates = new Map<string, Promise<void>>();
  let sequence = tasks.length;

  for (const seed of options.documents ?? []) {
    documents.set(`${seed.taskId}/${seed.name}`, {
      meta: { taskId: seed.taskId, name: seed.name, size: seed.content.length, updatedAt: NOW },
      content: seed.content,
    });
  }

  for (const [taskId, list] of Object.entries(options.versions ?? {})) {
    versions.set(
      taskId,
      list.map((version, index) => ({
        ...structuredClone(version),
        taskId,
        number: index + 1,
        createdAt: NOW,
      })),
    );
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

  const versionsOf = (taskId: string): TaskVersion[] => {
    require(taskId);
    const list = versions.get(taskId) ?? [];
    versions.set(taskId, list);
    return list;
  };

  const appendVersion = (
    taskId: string,
    version: Omit<TaskVersion, 'taskId' | 'number' | 'createdAt'>,
  ): TaskVersion => {
    const list = versionsOf(taskId);
    const made: TaskVersion = {
      ...structuredClone(version),
      taskId,
      number: list.length + 1,
      createdAt: NOW,
    };
    list.push(made);
    emit({ type: 'version.created', taskId, number: made.number });
    return made;
  };

  /** What the server does before a write of content: history ends at what is on disk. */
  const sync = (task: Task): void => {
    const list = versionsOf(task.id);
    const latest = list.at(-1);
    if (latest === undefined) {
      appendVersion(task.id, { source: 'baseline', changed: [], snapshot: contentOf(task) });
    } else if (!sameContent(latest.snapshot, task)) {
      appendVersion(task.id, {
        source: 'external',
        changed: changedFields(latest.snapshot, task),
        snapshot: contentOf(task),
      });
    }
  };

  const versionList = (taskId: string): VersionList => {
    const task = require(taskId);
    const list = versionsOf(taskId);
    const latest = list.at(-1);
    return {
      current: {
        hash: contentHash(contentOf(task)),
        version: latest !== undefined && sameContent(latest.snapshot, task) ? latest.number : null,
      },
      versions: list.map(({ snapshot, ...rest }) => ({ ...rest, hash: contentHash(snapshot) })),
    };
  };

  const checksOf = (taskId: string): Check[] => {
    require(taskId);
    return checks.get(taskId) ?? [];
  };

  const requireCheck = (taskId: string, number: number): Check => {
    const found = checksOf(taskId).find((check) => check.begin.number === number);
    if (!found) {
      throw new ApiError(404, 'CHECK_NOT_FOUND', `Task "${taskId}" has no check ${number}.`);
    }
    return found;
  };

  const workflowState = (): WorkflowState => ({
    defaults: defaultWorkflow(project.statuses),
    ...structuredClone(overrides),
  });

  const effectiveOf = (task: Task): EffectiveWorkflow =>
    resolveWorkflow(
      defaultWorkflow(project.statuses),
      overrides.board,
      Object.hasOwn(overrides.statuses, task.status) ? overrides.statuses[task.status] : undefined,
      task.workflow,
    );

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
          ...(input.workflow === undefined ? {} : { workflow: { ...input.workflow } }),
          createdAt: NOW,
          updatedAt: NOW,
        };
        tasks.push(task);
        versions.set(task.id, []);
        appendVersion(task.id, { source: 'create', changed: [], snapshot: contentOf(task) });
        emit({ type: 'task.created', task });
        return { ...task };
      }),
    updateTask: (id, patch) =>
      record('updateTask', () => {
        patches.push({ id, patch: structuredClone(patch) as Record<string, unknown> });
        const task = require(id);
        const { branch, workflow, aiRun, ifContentHash, fromCheck, ...rest } = patch;
        // The precondition of ADR-0030 §4, on the board's side of the wire.
        if (ifContentHash !== undefined && ifContentHash !== contentHash(contentOf(task))) {
          throw new ApiError(
            409,
            'TASK_CONTENT_CHANGED',
            `The content of task "${id}" is no longer the one the change was based on.`,
            { id, currentHash: contentHash(contentOf(task)), latestVersion: null },
          );
        }
        const next = {
          title: rest.title ?? task.title,
          body: rest.body ?? task.body,
          labels: rest.labels ?? task.labels,
        };
        const changed = changedFields(task, next);
        if (changed.length > 0) sync(task);
        Object.assign(task, rest, { updatedAt: NOW });
        if (changed.length > 0) {
          appendVersion(id, {
            source: 'edit',
            changed,
            snapshot: contentOf(task),
            ...(fromCheck === undefined ? {} : { fromCheck }),
          });
        }
        if (aiRun === null) delete task.aiRun;
        if (branch === null) delete task.branch;
        else if (branch !== undefined) task.branch = branch;
        if (workflow === null) delete task.workflow;
        else if (workflow !== undefined) task.workflow = { ...workflow };
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

    workflow: () => record('workflow', workflowState),
    updateWorkflow: (next) =>
      record('updateWorkflow', () => {
        overrides.board = structuredClone(next.board);
        overrides.statuses = structuredClone(next.statuses);
        const state = workflowState();
        emit({ type: 'workflow.updated', workflow: state });
        return state;
      }),
    taskWorkflow: (id) => record('taskWorkflow', () => effectiveOf(require(id))),
    runTask: (id, request) =>
      record('runTask', () => {
        require(id);
        runs.push({ taskId: id, ...structuredClone(request) });
        // As the board answers: `kind` only for a check or a research, never "work"; no comment.
        const { kind, comment: _comment, ...rest } = structuredClone(request);
        return {
          taskId: id,
          ...rest,
          ...(kind === 'check' || kind === 'research' ? { kind } : {}),
        };
      }),
    handoff: (id) =>
      record('handoff', () => {
        const task = require(id);
        // The real generator over the real effective settings: what the page copies is what an
        // agent would be given, not a sentence made up for the test.
        return generateHandoff({
          task: structuredClone(task),
          documents: [...documents.values()]
            .filter((document) => document.meta.taskId === id)
            .map((document) => document.meta),
          effective: effectiveOf(task),
          instructions: options.instructions ?? '# API\n',
        });
      }),

    versions: (taskId) => record('versions', () => structuredClone(versionList(taskId))),
    version: (taskId, number) =>
      record('version', () => {
        const found = versionsOf(taskId).find((version) => version.number === number);
        if (!found) {
          throw new ApiError(
            404,
            'VERSION_NOT_FOUND',
            `Task "${taskId}" has no version ${number}.`,
          );
        }
        return structuredClone(found);
      }),
    restoreVersion: (taskId, number, ifContentHash) =>
      record('restoreVersion', () => {
        const task = require(taskId);
        if (ifContentHash !== contentHash(contentOf(task))) {
          throw new ApiError(
            409,
            'TASK_CONTENT_CHANGED',
            `The content of task "${taskId}" is no longer the one the change was based on.`,
          );
        }
        const target = versionsOf(taskId).find((version) => version.number === number);
        if (!target) {
          throw new ApiError(
            404,
            'VERSION_NOT_FOUND',
            `Task "${taskId}" has no version ${number}.`,
          );
        }
        if (sameContent(target.snapshot, task)) return { task: { ...task }, changed: false };
        sync(task);
        const changed = changedFields(task, target.snapshot);
        Object.assign(task, structuredClone(target.snapshot), { updatedAt: NOW });
        appendVersion(taskId, {
          source: 'restore',
          changed,
          snapshot: contentOf(task),
          restoredFrom: number,
        });
        emit({ type: 'task.updated', task: { ...task } });
        return { task: { ...task }, changed: true };
      }),
    checks: (taskId) => record('checks', () => checksOf(taskId).map(summarizeCheck)),
    check: (taskId, number) => record('check', () => structuredClone(requireCheck(taskId, number))),
    checkReportMarkdown: (taskId, number) =>
      record('checkReportMarkdown', () => {
        const check = requireCheck(taskId, number);
        if (check.report === undefined) {
          throw new ApiError(409, 'CHECK_NOT_REPORTED', 'The check has no report yet.');
        }
        const text = options.researchMarkdown?.[`${taskId}/${number}`];
        if (text === undefined) {
          throw new ApiError(404, 'CHECK_NOT_FOUND', 'It is not a research.');
        }
        return text;
      }),
    decide: (taskId, number, input) =>
      record('decide', () => {
        const check = requireCheck(taskId, number);
        if (check.state !== 'reported' || check.report === undefined) {
          throw new ApiError(409, 'CHECK_NOT_REPORTED', 'The check has no report to decide on.');
        }
        if (!check.report.recommendations.some((r) => r.id === input.recommendation)) {
          throw new ApiError(404, 'RECOMMENDATION_NOT_FOUND', 'No such recommendation.');
        }
        const decision: Decision = {
          taskId,
          check: number,
          number: check.decisions.length + 1,
          recommendation: input.recommendation,
          decision: input.decision,
          ...(input.note === undefined ? {} : { note: input.note }),
          createdAt: NOW,
        };
        check.decisions.push(decision);
        latestDecisions(check.decisions);
        emit({ type: 'check.updated', taskId, number });
        return { ...decision };
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
    gitCommits: (_limit, _ref) =>
      record('gitCommits', () => options.commits ?? ([] as GitCommit[])),
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
    workflow: overrides,
    runs,
    versions,
    checks,
    patches,
    fail: (method, error) => failures.set(method, error),
    hold(method) {
      let release = (): void => undefined;
      gates.set(method, new Promise<void>((resolve) => (release = resolve)));
      return release;
    },
  };
}
