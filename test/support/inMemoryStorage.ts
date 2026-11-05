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
  Topic,
  WorkflowOverrides,
} from '../../src/core/model/index.js';
import type { NewReport, NewTask, NewVersion, Storage, TaskPatch } from '../../src/core/ports.js';
import {
  assertBlockDeletable,
  assertTopicDeletable,
  reorderedBlocks,
  requireBlock,
} from '../../src/core/rules/topicWrites.js';
import { isDocumentName } from '../../src/core/rules/documentName.js';
import {
  assertDependencies,
  assertPlacement,
  type PlacementWrite,
} from '../../src/core/rules/placement.js';
import { assembleCheck, storedCheckReport } from '../../src/core/rules/history.js';
import {
  BLOCK_ID_PREFIX,
  REPORT_ID_PREFIX,
  TOPIC_ID_PREFIX,
  allocateId,
  allocateRecoverableId,
  highestIdNumber,
} from '../../src/core/rules/ids.js';

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
  /** null is a topic that cannot be read, as a broken topic.md would be. */
  topics: Map<string, Topic | null>;
  /** null is counters that are missing or invalid (ADR-0032 §2, O-1). */
  topicSequence: { topicSequence: number; blockSequence: number } | null;
}

export interface MemoryHistory {
  versions: TaskVersion[];
  checks: Map<
    number,
    {
      begin: CheckBegin;
      report?: CheckReport;
      end?: CheckEnd;
      decisions: Decision[];
      /** The report.md of a research: written before its record, so it can be there alone. */
      markdown?: string;
    }
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
    topics: new Map(),
    topicSequence: { topicSequence: 0, blockSequence: 0 },
  };
}

export function inMemoryStorage(store: MemoryStore, options: { idPrefix?: string } = {}): Storage {
  const idPrefix = options.idPrefix ?? 'T';
  const now = (): string => new Date().toISOString();

  /**
   * The checks of a task write await, so without this another write could come between the
   * check and the write; the same promise chain as the Markdown provider's (T85).
   */
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action, action);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  const dependencyBoard = async () => ({ tasks: [...store.tasks.values()], unreadable: [] });

  async function assertPlaced(task: Task, write: PlacementWrite): Promise<void> {
    await assertPlacement(write, task, idPrefix, async (id) => store.topics.get(id) ?? null);
    await assertDependencies(task.id, write.dependsOn, dependencyBoard);
  }

  function requireTask(id: string): Task {
    const task = store.tasks.get(id);
    if (!task) throw new BoardError('TASK_NOT_FOUND', `Task "${id}" does not exist.`, { id });
    return task;
  }

  /** The task as `patch` leaves it, its place checked, and nothing written; inside `exclusive`. */
  async function patched(id: string, patch: TaskPatch): Promise<Task> {
    const task = requireTask(id);
    const { branch, workflow, aiRun, topic, block, dependsOn, ...rest } = patch;
    await assertPlaced(task, { topic, block, dependsOn });
    const updated: Task = { ...task, ...prune(rest), updatedAt: now() };
    if (topic === null) delete updated.topic;
    else if (topic !== undefined) updated.topic = topic;
    if (block === null) delete updated.block;
    else if (block !== undefined) updated.block = block;
    if (dependsOn === null) delete updated.dependsOn;
    else if (dependsOn !== undefined) updated.dependsOn = [...dependsOn];
    if (branch === null) delete updated.branch;
    else if (branch !== undefined) updated.branch = branch;
    if (workflow === null) delete updated.workflow;
    else if (workflow !== undefined) updated.workflow = { ...workflow };
    if (aiRun === null) delete updated.aiRun;
    else if (aiRun !== undefined) updated.aiRun = { ...aiRun };
    return updated;
  }

  /** The append itself, outside the queue: for a section that holds it already. */
  function appendVersion(taskId: string, input: NewVersion): TaskVersion {
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

  /** The same rule as the markdown provider's: recover a lost counter only from what was read. */
  function allocateTopicOrBlockId(prefix: string, check: () => void = () => {}): string {
    const topics = [...store.topics.values()].filter((topic): topic is Topic => topic !== null);
    const topicIds = [...store.topics.keys()];
    const blockIds = topics.flatMap((topic) => topic.blocks.map((block) => block.id));
    const unreadable = topicIds
      .filter((id) => store.topics.get(id) === null)
      .map((id) => `topics/${id}/topic.md`);
    const stored = store.topicSequence;
    const isTopic = prefix === TOPIC_ID_PREFIX;
    const { id, sequence } = allocateRecoverableId(
      prefix,
      (isTopic ? stored?.topicSequence : stored?.blockSequence) ?? null,
      isTopic ? topicIds : blockIds,
      unreadable,
    );
    check();
    store.topicSequence = {
      topicSequence: isTopic
        ? sequence
        : Math.max(stored?.topicSequence ?? 0, highestIdNumber(TOPIC_ID_PREFIX, topicIds)),
      blockSequence: isTopic
        ? Math.max(stored?.blockSequence ?? 0, highestIdNumber(BLOCK_ID_PREFIX, blockIds))
        : sequence,
    };
    return id;
  }

  /** As the markdown provider does: what a delete leaves behind keeps its ids used. */
  function keepCounters(): void {
    const topics = [...store.topics.values()].filter((topic): topic is Topic => topic !== null);
    const topicIds = [...store.topics.keys()];
    const blockIds = topics.flatMap((topic) => topic.blocks.map((block) => block.id));
    const stored = store.topicSequence;
    const unreadable = topicIds
      .filter((id) => store.topics.get(id) === null)
      .map((id) => `topics/${id}/topic.md`);
    const { sequence } = allocateRecoverableId(
      TOPIC_ID_PREFIX,
      stored?.topicSequence ?? null,
      topicIds,
      unreadable,
    );
    store.topicSequence = {
      topicSequence: sequence - 1,
      blockSequence: Math.max(
        stored?.blockSequence ?? 0,
        highestIdNumber(BLOCK_ID_PREFIX, blockIds),
      ),
    };
  }

  function requireTopic(id: string): Topic {
    const topic = store.topics.get(id);
    if (!topic) {
      throw new BoardError('TOPIC_NOT_FOUND', `Topic "${id}" does not exist.`, { id });
    }
    return topic;
  }

  return {
    init: async () => {},
    close: async () => {},

    listTasks: async () => [...store.tasks.values()],
    /** Memory cannot hold an unreadable task; the board it backs never has read problems. */
    readIssues: async () =>
      [...store.topics]
        .filter(([, topic]) => topic === null)
        .map(([id]) => ({ file: `topics/${id}/topic.md`, message: 'The file cannot be read.' })),
    getTask: async (id) => store.tasks.get(id) ?? null,

    createTask: (input: NewTask) =>
      exclusive(async () => {
        await assertPlacement(input, {}, idPrefix, async (id) => store.topics.get(id) ?? null);
        const { id, sequence } = allocateId(idPrefix, store.taskSequence, store.tasks.keys());
        await assertDependencies(id, input.dependsOn, dependencyBoard);
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
          ...(input.topic === undefined ? {} : { topic: input.topic }),
          ...(input.block === undefined ? {} : { block: input.block }),
          ...(input.dependsOn === undefined ? {} : { dependsOn: [...input.dependsOn] }),
          createdAt: timestamp,
          updatedAt: timestamp,
          ...(input.extra === undefined ? {} : { extra: { ...input.extra } }),
        };
        store.tasks.set(id, task);
        return task;
      }),

    updateTask: (id, patch: TaskPatch) =>
      exclusive(async () => {
        const updated = await patched(id, patch);
        store.tasks.set(id, updated);
        return updated;
      }),

    // As the markdown provider: one section, the versions appended without entering it again.
    updateTaskContent: (id, patch: TaskPatch, { sync, version }) =>
      exclusive(async () => {
        const updated = await patched(id, patch);
        const versions = sync === undefined ? [] : [appendVersion(id, sync)];
        store.tasks.set(id, updated);
        versions.push(appendVersion(id, version));
        return { task: updated, versions };
      }),

    readWorkflow: async () => structuredClone(store.workflow),
    writeWorkflow: async (workflow) => {
      store.workflow = structuredClone(workflow);
    },

    deleteTask: (id) =>
      exclusive(async () => {
        requireTask(id);
        store.tasks.delete(id);
        store.documents.delete(id);
        store.history.delete(id);
      }),

    // In the queue of the writes, as the markdown provider's is.
    appendVersion: (taskId, input) => exclusive(async () => appendVersion(taskId, input)),
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
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.comment === undefined ? {} : { comment: input.comment }),
        ...(input.documents === undefined ? {} : { documents: input.documents }),
      };
      history.checks.set(number, { begin, decisions: [] });
      return structuredClone(begin);
    },
    writeCheckReport: async (taskId, number, input) => {
      const check = requireCheckRecord(taskId, number);
      if (check.end !== undefined) throw alreadyFinal(taskId, number);
      const { report, markdown } = storedCheckReport(check.begin, {
        ...input,
        createdAt: input.createdAt ?? now(),
      });
      if (markdown !== undefined) {
        if (check.report !== undefined) throw alreadyFinal(taskId, number);
        if (check.markdown !== undefined && check.markdown !== markdown) {
          throw alreadyFinal(taskId, number);
        }
        check.markdown = markdown;
      }
      if (check.report !== undefined) throw alreadyFinal(taskId, number);
      check.report = structuredClone(report);
      return structuredClone(report);
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
        ...(input.repo === undefined ? {} : { repo: input.repo }),
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
    readCheckMarkdown: async (taskId, number) => {
      const check = historyOf(taskId).checks.get(number);
      return check?.report?.markdown === undefined ? null : (check.markdown ?? null);
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

    getTopic: async (id) => structuredClone(store.topics.get(id) ?? null),

    listTopics: async () =>
      [...store.topics.values()]
        .filter((topic): topic is Topic => topic !== null)
        .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
        .map((topic) => structuredClone(topic)),

    readTopicSequence: async () => structuredClone(store.topicSequence),

    createTopic: async (input) => {
      const id = allocateTopicOrBlockId(TOPIC_ID_PREFIX);
      const topic: Topic = { id, title: input.title, body: input.body, blocks: [] };
      store.topics.set(id, topic);
      return structuredClone(topic);
    },

    createBlock: async (topicId, input) => {
      const id = allocateTopicOrBlockId(BLOCK_ID_PREFIX, () => {
        if (!store.topics.get(topicId)) {
          throw new BoardError('TOPIC_NOT_FOUND', `Topic "${topicId}" does not exist.`, {
            id: topicId,
          });
        }
      });
      const block = { id, title: input.title };
      store.topics.get(topicId)?.blocks.push(block);
      return { ...block };
    },

    updateTopic: async (id, patch) => {
      const topic = requireTopic(id);
      if (patch.title !== undefined) topic.title = patch.title;
      if (patch.body !== undefined) topic.body = patch.body;
      return structuredClone(topic);
    },

    deleteTopic: (id) =>
      exclusive(async () => {
        const topic = requireTopic(id);
        assertTopicDeletable(topic, [...store.tasks.values()]);
        keepCounters();
        store.topics.delete(id);
      }),

    updateBlock: async (topicId, blockId, patch) => {
      const topic = requireTopic(topicId);
      const block = requireBlock(topic, blockId);
      block.title = patch.title;
      return { ...block };
    },

    reorderBlocks: async (topicId, order) => {
      const topic = requireTopic(topicId);
      topic.blocks = reorderedBlocks(topic, order);
      return structuredClone(topic);
    },

    deleteBlock: (topicId, blockId) =>
      exclusive(async () => {
        const topic = requireTopic(topicId);
        requireBlock(topic, blockId);
        assertBlockDeletable(topic, blockId, [...store.tasks.values()]);
        keepCounters();
        topic.blocks = topic.blocks.filter((block) => block.id !== blockId);
      }),

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
