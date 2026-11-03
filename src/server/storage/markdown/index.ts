import { mkdir, readFile, readdir, rm, stat, watch, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BoardError } from '../../../core/errors.js';
import type {
  Block,
  DocumentMeta,
  Report,
  Task,
  Topic,
  WorkflowOverrides,
} from '../../../core/model/index.js';
import type { NewReport, NewTask, ReadIssue, Storage, TaskPatch } from '../../../core/ports.js';
import {
  assertBlockDeletable,
  assertTopicDeletable,
  reorderedBlocks,
  requireBlock,
} from '../../../core/rules/topicWrites.js';
import { documentFormat, isDocumentName } from '../../../core/rules/documentName.js';
import {
  BLOCK_ID_PREFIX,
  REPORT_ID_PREFIX,
  TOPIC_ID_PREFIX,
  allocateId,
  allocateRecoverableId,
  highestIdNumber,
  isReportId,
  isTaskId,
  isTopicId,
} from '../../../core/rules/ids.js';
import { assertPlacement } from '../../../core/rules/placement.js';
import { findWorkflowIssues } from '../../../core/rules/workflow.js';
import { writeFileAtomic } from './atomic.js';
import { historyFiles } from './history.js';
import { parseTask, serializeTask } from './taskFile.js';
import { parseTopic, serializeTopic } from './topicFile.js';
import { parseWorkflow, serializeWorkflow } from './workflowFile.js';

export interface MarkdownStorageOptions {
  /** The board root; the board itself lives in <root>/.board. */
  root: string;
  idPrefix?: string | undefined;
  /**
   * The configured statuses. When given, workflow overrides for a status that is not among them
   * are reported by `readIssues`.
   */
  statuses?: readonly string[] | undefined;
  /** Called when the board changed outside the server; drives live updates, never correctness. */
  onExternalChange?: (() => void) | undefined;
}

interface BoardState {
  formatVersion: 1;
  taskSequence: number;
  reportSequence: number;
}

/**
 * The counters of topics and blocks. Not in board.json: an earlier board writes that file with
 * the keys it knows and would drop these (ADR-0032 §2).
 */
interface TopicSequence {
  formatVersion: 1;
  topicSequence: number;
  blockSequence: number;
}

/** What a scan of the topics found: every id in use, and the files it could not read. */
interface TopicScan {
  topics: Map<string, Topic>;
  topicIds: string[];
  blockIds: string[];
  unreadable: ReadIssue[];
}

const STATE_FILE = 'board.json';
const SEQUENCE_FILE = 'sequence.json';
const TASK_FILE = 'task.md';
const TOPIC_FILE = 'topic.md';
const WORKFLOW_FILE = 'workflow.yaml';
const NO_WORKFLOW: WorkflowOverrides = { board: {}, statuses: {} };

/**
 * The default provider and the source of truth (ADR-0002). Every read goes to disk
 * (ADR-0019); the watcher only tells open clients that something changed.
 */
export function markdownStorage(options: MarkdownStorageOptions): Storage {
  const boardDir = join(options.root, '.board');
  const tasksDir = join(boardDir, 'tasks');
  const reportsDir = join(boardDir, 'reports');
  const topicsDir = join(boardDir, 'topics');
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

  const history = historyFiles({ taskDir: (id) => join(tasksDir, id), now });

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

  /** Null when the file is missing or invalid: the counters are then recovered (O-1). */
  async function readTopicSequence(): Promise<TopicSequence | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(topicsDir, SEQUENCE_FILE), 'utf8'));
    } catch {
      return null;
    }
    const value = parsed as Partial<TopicSequence> | null;
    const valid =
      typeof value === 'object' &&
      value !== null &&
      value.formatVersion === 1 &&
      isCounter(value.topicSequence) &&
      isCounter(value.blockSequence);
    return valid ? (value as TopicSequence) : null;
  }

  async function readTopicFile(id: string): Promise<{ topic: Topic } | { error: string }> {
    try {
      return parseTopic(id, await readFile(join(topicsDir, id, TOPIC_FILE), 'utf8'));
    } catch (error) {
      return { error: `The file cannot be read: ${(error as Error).message}` };
    }
  }

  async function topicById(id: string): Promise<Topic | null> {
    if (!isTopicId(id)) return null;
    const result = await readTopicFile(id);
    return 'topic' in result ? result.topic : null;
  }

  async function scanTopics(): Promise<TopicScan> {
    // A board of an earlier version has no topics directory: it has no topics, not a problem.
    const entries = await readdir(topicsDir, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    const scan: TopicScan = { topics: new Map(), topicIds: [], blockIds: [], unreadable: [] };
    for (const entry of entries) {
      if (!entry.isDirectory() || !isTopicId(entry.name)) continue;
      // A directory holds its id even when its file cannot be read.
      scan.topicIds.push(entry.name);
      const result = await readTopicFile(entry.name);
      if ('topic' in result) {
        scan.topics.set(entry.name, result.topic);
        scan.blockIds.push(...result.topic.blocks.map((block) => block.id));
      } else {
        scan.unreadable.push({
          file: `topics/${entry.name}/${TOPIC_FILE}`,
          message: result.error,
        });
      }
    }
    return scan;
  }

  /**
   * Allocates an id of `prefix` and returns the counters to write once the topic is written.
   * Both counters are carried forward, so a recovered one is persisted with the other.
   */
  async function allocateTopicOrBlockId(
    prefix: typeof TOPIC_ID_PREFIX | typeof BLOCK_ID_PREFIX,
    scan: TopicScan,
  ): Promise<{ id: string; next: TopicSequence }> {
    const stored = await readTopicSequence();
    const isTopic = prefix === TOPIC_ID_PREFIX;
    const { id, sequence } = allocateRecoverableId(
      prefix,
      (isTopic ? stored?.topicSequence : stored?.blockSequence) ?? null,
      isTopic ? scan.topicIds : scan.blockIds,
      scan.unreadable.map((issue) => issue.file),
    );
    const carried = (other: string, value: number | undefined, ids: string[]): number =>
      Math.max(value ?? 0, highestIdNumber(other, ids));
    return {
      id,
      next: {
        formatVersion: 1,
        topicSequence: isTopic
          ? sequence
          : carried(TOPIC_ID_PREFIX, stored?.topicSequence, scan.topicIds),
        blockSequence: isTopic
          ? carried(BLOCK_ID_PREFIX, stored?.blockSequence, scan.blockIds)
          : sequence,
      },
    };
  }

  async function writeTopicSequence(sequence: TopicSequence): Promise<void> {
    await writeFileAtomic(join(topicsDir, SEQUENCE_FILE), `${JSON.stringify(sequence, null, 2)}\n`);
  }

  async function saveTopic(topic: Topic): Promise<void> {
    await writeFileAtomic(join(topicsDir, topic.id, TOPIC_FILE), serializeTopic(topic));
  }

  /**
   * The counters a delete leaves behind: the stored ones, or those recovered from the ids that
   * exist, whichever is higher. Written before the delete, so the id of what is deleted stays
   * used even when the counters were lost or behind (ADR-0020). Fail-closed like a create (O-1).
   */
  async function keepCounters(scan: TopicScan): Promise<void> {
    const stored = await readTopicSequence();
    // The sequence an allocation would return is one past the highest id in use.
    const topicSequence =
      allocateRecoverableId(
        TOPIC_ID_PREFIX,
        stored?.topicSequence ?? null,
        scan.topicIds,
        scan.unreadable.map((issue) => issue.file),
      ).sequence - 1;
    const blockSequence = Math.max(
      stored?.blockSequence ?? 0,
      highestIdNumber(BLOCK_ID_PREFIX, scan.blockIds),
    );
    if (stored?.topicSequence === topicSequence && stored.blockSequence === blockSequence) {
      return;
    }
    await writeTopicSequence({ formatVersion: 1, topicSequence, blockSequence });
  }

  /** The tasks a delete must look at, and the task files it cannot read and so cannot rule out. */
  async function tasksForDelete(): Promise<{ tasks: Task[]; unreadable: string[] }> {
    const tasks: Task[] = [];
    const unreadable: string[] = [];
    for (const id of (await taskIds()).sort(byNumber)) {
      const result = await readTaskFile(id);
      if (result !== null && 'task' in result) tasks.push(result.task);
      else if (result !== null) unreadable.push(`tasks/${id}/${TASK_FILE}`);
    }
    return { tasks, unreadable };
  }

  function topicNotFound(id: string): BoardError {
    return new BoardError('TOPIC_NOT_FOUND', `Topic "${id}" does not exist.`, { id });
  }

  async function taskIds(): Promise<string[]> {
    const entries = await readdir(tasksDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && isTaskId(entry.name))
      .map((e) => e.name);
  }

  async function readTaskFile(id: string): Promise<{ task: Task } | { error: string } | null> {
    try {
      return parseTask(id, await readFile(join(tasksDir, id, TASK_FILE), 'utf8'));
    } catch {
      return null;
    }
  }

  async function loadTask(id: string): Promise<Task | null> {
    const result = await readTaskFile(id);
    return result !== null && 'task' in result ? result.task : null;
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

  /** `null` when there is no file: that is an empty set of overrides, not a problem. */
  async function readWorkflowFile(): Promise<
    { workflow: WorkflowOverrides } | { error: string } | null
  > {
    let text: string;
    try {
      text = await readFile(join(boardDir, WORKFLOW_FILE), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return { error: `The file cannot be read: ${(error as Error).message}` };
    }
    return parseWorkflow(text);
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

    async readIssues() {
      const ids = (await taskIds()).sort(byNumber);
      const issues: ReadIssue[] = [];
      for (const id of ids) {
        const result = await readTaskFile(id);
        if (result !== null && 'error' in result) {
          issues.push({ file: `tasks/${id}/${TASK_FILE}`, message: result.error });
        }
        issues.push(...(await history.issues(id)));
      }
      const unreadableTopics = (await scanTopics()).unreadable;
      for (const { file, message } of unreadableTopics) issues.push({ file, message });
      const workflow = await readWorkflowFile();
      if (workflow !== null && 'error' in workflow) {
        issues.push({ file: WORKFLOW_FILE, message: workflow.error });
      } else if (workflow !== null && options.statuses !== undefined) {
        for (const message of findWorkflowIssues(workflow.workflow, options.statuses)) {
          issues.push({ file: WORKFLOW_FILE, message });
        }
      }
      return issues;
    },

    async readWorkflow() {
      const result = await readWorkflowFile();
      // A file that cannot be used means defaults; `readIssues` says why.
      return result !== null && 'workflow' in result
        ? result.workflow
        : structuredClone(NO_WORKFLOW);
    },

    writeWorkflow(workflow) {
      return exclusive(() =>
        writeFileAtomic(join(boardDir, WORKFLOW_FILE), serializeWorkflow(workflow)),
      );
    },

    createTask(input: NewTask) {
      return exclusive(async () => {
        const state = await readState();
        await assertPlacement(input, {}, idPrefix, topicById);
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
          ...(input.workflow === undefined ? {} : { workflow: { ...input.workflow } }),
          ...(input.topic === undefined ? {} : { topic: input.topic }),
          ...(input.block === undefined ? {} : { block: input.block }),
          ...(input.dependsOn === undefined ? {} : { dependsOn: [...input.dependsOn] }),
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
        const { branch, workflow, aiRun, topic, block, dependsOn, ...rest } = patch;
        await assertPlacement({ topic, block, dependsOn }, task, idPrefix, topicById);
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

    // The history of a task: add and read, nothing else (ADR-0030). A write waits for the queue
    // of the storage like every write, and needs the task to exist.
    appendVersion(taskId, input) {
      return exclusive(async () => {
        await requireTask(taskId);
        return history.appendVersion(taskId, input);
      });
    },

    async listVersions(taskId) {
      await requireTask(taskId);
      return history.listVersions(taskId);
    },

    async readVersion(taskId, number) {
      await requireTask(taskId);
      return history.readVersion(taskId, number);
    },

    beginCheck(taskId, input) {
      return exclusive(async () => {
        await requireTask(taskId);
        return history.beginCheck(taskId, input);
      });
    },

    writeCheckReport(taskId, number, input) {
      return exclusive(async () => {
        await requireTask(taskId);
        return history.writeCheckReport(taskId, number, input);
      });
    },

    endCheck(taskId, number, input) {
      return exclusive(async () => {
        await requireTask(taskId);
        return history.endCheck(taskId, number, input);
      });
    },

    async listChecks(taskId) {
      await requireTask(taskId);
      return history.listChecks(taskId);
    },

    async readCheckMarkdown(taskId, number) {
      await requireTask(taskId);
      return history.readCheckMarkdown(taskId, number);
    },

    async readCheck(taskId, number) {
      await requireTask(taskId);
      return history.readCheck(taskId, number);
    },

    appendDecision(taskId, number, input) {
      return exclusive(async () => {
        await requireTask(taskId);
        return history.appendDecision(taskId, number, input);
      });
    },

    getTopic: topicById,

    createTopic(input) {
      return exclusive(async () => {
        const { id, next } = await allocateTopicOrBlockId(TOPIC_ID_PREFIX, await scanTopics());
        const topic: Topic = { id, title: input.title, body: input.body, blocks: [] };
        await mkdir(join(topicsDir, id), { recursive: true });
        await saveTopic(topic);
        await writeTopicSequence(next);
        return topic;
      });
    },

    createBlock(topicId, input) {
      return exclusive(async () => {
        const scan = await scanTopics();
        const { id, next } = await allocateTopicOrBlockId(BLOCK_ID_PREFIX, scan);
        const topic = scan.topics.get(topicId);
        if (!topic) {
          throw new BoardError('TOPIC_NOT_FOUND', `Topic "${topicId}" does not exist.`, {
            id: topicId,
          });
        }
        const block: Block = { id, title: input.title };
        await saveTopic({ ...topic, blocks: [...topic.blocks, block] });
        await writeTopicSequence(next);
        return block;
      });
    },

    updateTopic(id, patch) {
      return exclusive(async () => {
        const topic = await topicById(id);
        if (!topic) throw topicNotFound(id);
        const updated: Topic = {
          ...topic,
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.body === undefined ? {} : { body: patch.body }),
        };
        await saveTopic(updated);
        return updated;
      });
    },

    deleteTopic(id) {
      return exclusive(async () => {
        const scan = await scanTopics();
        const topic = scan.topics.get(id);
        if (!topic) throw topicNotFound(id);
        const { tasks, unreadable } = await tasksForDelete();
        assertTopicDeletable(topic, tasks, unreadable);
        await keepCounters(scan);
        await rm(join(topicsDir, id), { recursive: true, force: true });
      });
    },

    updateBlock(topicId, blockId, patch) {
      return exclusive(async () => {
        const topic = await topicById(topicId);
        if (!topic) throw topicNotFound(topicId);
        const block: Block = { ...requireBlock(topic, blockId), title: patch.title };
        await saveTopic({
          ...topic,
          blocks: topic.blocks.map((held) => (held.id === blockId ? block : held)),
        });
        return block;
      });
    },

    reorderBlocks(topicId, order) {
      return exclusive(async () => {
        const topic = await topicById(topicId);
        if (!topic) throw topicNotFound(topicId);
        const reordered: Topic = { ...topic, blocks: reorderedBlocks(topic, order) };
        await saveTopic(reordered);
        return reordered;
      });
    },

    deleteBlock(topicId, blockId) {
      return exclusive(async () => {
        const scan = await scanTopics();
        const topic = scan.topics.get(topicId);
        if (!topic) throw topicNotFound(topicId);
        requireBlock(topic, blockId);
        const { tasks, unreadable } = await tasksForDelete();
        assertBlockDeletable(topic, blockId, tasks, unreadable);
        await keepCounters(scan);
        await saveTopic({
          ...topic,
          blocks: topic.blocks.filter((held) => held.id !== blockId),
        });
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

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
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
