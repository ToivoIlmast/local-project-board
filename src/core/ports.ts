import type { BoardEvent } from './events.js';
import type {
  AiRun,
  Block,
  Check,
  CheckBegin,
  CheckEnd,
  CheckReport,
  CheckReportContent,
  Decision,
  DocumentMeta,
  GitBranch,
  GitCommit,
  GitDiff,
  GitStatus,
  Report,
  RepoState,
  ResearchReportContent,
  Task,
  TaskVersion,
  TaskWorkflowOverrides,
  Topic,
  WorkflowOverrides,
} from './model/index.js';

/** A task as the caller describes it; the provider assigns the id and the timestamps. */
export interface NewTask {
  title: string;
  status: string;
  rank: string;
  body: string;
  labels: string[];
  branch?: string | undefined;
  workflow?: TaskWorkflowOverrides | undefined;
  topic?: string | undefined;
  /** Only with `topic`, and a block of it. */
  block?: string | undefined;
  /** Task ids in the form of the board's id prefix. */
  dependsOn?: string[] | undefined;
  extra?: Record<string, unknown> | undefined;
}

/**
 * Only the given fields change. `branch: null` clears the branch; `workflow: null` clears all of
 * the task's workflow overrides, and a `workflow` object replaces them whole, as `labels` does.
 * `aiRun` is the same: an object replaces the reported run whole, null forgets it. `topic`,
 * `block` and `dependsOn` are set or cleared (null) the same way; what a write names of them must
 * hold against the board, or it is refused and nothing changes (ADR-0032 §3–4, T85): the place
 * that results must be whole (`INVALID_PLACEMENT`), and `dependsOn` must name tasks that can be
 * read (`INVALID_DEPENDENCY`) and put the task in no cycle (`DEPENDENCY_CYCLE`).
 */
export interface TaskPatch {
  title?: string | undefined;
  status?: string | undefined;
  rank?: string | undefined;
  body?: string | undefined;
  labels?: string[] | undefined;
  branch?: string | null | undefined;
  workflow?: TaskWorkflowOverrides | null | undefined;
  aiRun?: AiRun | null | undefined;
  topic?: string | null | undefined;
  block?: string | null | undefined;
  dependsOn?: string[] | null | undefined;
  extra?: Record<string, unknown> | undefined;
}

/** A version as the caller describes it; the provider assigns the number (ADR-0030 §2). */
export type NewVersion = Omit<TaskVersion, 'taskId' | 'number' | 'createdAt'> & {
  createdAt?: string | undefined;
};

/** The versions a write of content brings, planned by the caller (see `updateTaskContent`). */
export interface TaskWriteHistory {
  /** The `baseline` or `external` that makes history end at the content read; before the task. */
  sync?: NewVersion | undefined;
  /** The version of the new content; after the task. */
  version: NewVersion;
}

export type NewCheckBegin = Omit<CheckBegin, 'taskId' | 'number' | 'createdAt'> & {
  createdAt?: string | undefined;
};

/**
 * A report as the caller describes it: an actuality check's has a `verdict`, a research's has
 * its `markdown` as text. The provider stores the text in a file of its own and keeps its size
 * and hash in the record (ADR-0030 R3).
 */
export type NewCheckReport = (CheckReportContent | ResearchReportContent) & {
  version: number;
  repo: RepoState;
  createdAt?: string | undefined;
};

export type NewCheckEnd = Omit<CheckEnd, 'taskId' | 'check' | 'endedAt'> & {
  endedAt?: string | undefined;
};

export type NewDecision = Omit<Decision, 'taskId' | 'check' | 'number' | 'createdAt'> & {
  createdAt?: string | undefined;
};

/** A topic as the caller describes it; the provider assigns the id, and it has no blocks yet. */
export interface NewTopic {
  title: string;
  body: string;
}

export interface NewBlock {
  title: string;
}

/** Only the given fields change; the id and the blocks are not a topic's to patch. */
export interface TopicPatch {
  title?: string | undefined;
  body?: string | undefined;
}

export interface NewReport {
  title: string;
  format: 'html' | 'md';
  content: string;
}

/** A file on the board that cannot be read as a task, reported separately from the tasks. */
export interface ReadIssue {
  /** Path relative to the board directory, e.g. tasks/T7/task.md */
  file: string;
  message: string;
}

/**
 * Persistence. Deliberately without queries, transactions, configuration or watching:
 * filtering happens in services, and watching is the Markdown adapter's own business.
 * A provider persists; the rules live in core/rules.
 */
export interface Storage {
  init(): Promise<void>;
  close(): Promise<void>;

  listTasks(): Promise<Task[]>;
  /**
   * What could not be read on the last scan, the workflow settings included. A file that is
   * fixed stops being reported.
   */
  readIssues(): Promise<ReadIssue[]>;
  getTask(id: string): Promise<Task | null>;
  /**
   * Allocates the id atomically; an id is never reused (ADR-0020). The checks of `topic`, `block`
   * and `dependsOn` (see `TaskPatch`) apply, and a refused create uses no id.
   *
   * A create, an update and a delete of a task, and a delete of a topic or a block, are ordered:
   * the checks of one and its write are never parted by another (T85). So two writes that would
   * make a cycle together cannot both be taken.
   */
  createTask(input: NewTask): Promise<Task>;
  updateTask(id: string, patch: TaskPatch): Promise<Task>;
  /**
   * `updateTask` of a change of content, with the versions it brings (ADR-0030 §3), in one of
   * the ordered sections of `createTask`: the task is read and the place checked, then `sync` is
   * appended, then the task written, then `version` appended. A refused place writes nothing,
   * and no write of the board comes between the check and the last append (T85). Returns the
   * versions appended, in that order.
   *
   * Ordered against this provider's own writes only: a file edited by hand or a second process
   * is not. A write that fails part way stops there, and what was appended before it stays.
   */
  updateTaskContent(
    id: string,
    patch: TaskPatch,
    history: TaskWriteHistory,
  ): Promise<{ task: Task; versions: TaskVersion[] }>;
  /** Deletes the task, its documents and its history. */
  deleteTask(id: string): Promise<void>;

  /**
   * The overrides of the board and its columns: only what was set, never the settings a task
   * runs with (ADR-0028). No overrides is `{ board: {}, statuses: {} }`, not an error; so is
   * a stored value that cannot be read, which `readIssues` reports instead. Every call reads
   * the store afresh, and the caller gets its own copy.
   */
  readWorkflow(): Promise<WorkflowOverrides>;
  /** Replaces the board's and the columns' overrides whole. The caller validates them. */
  writeWorkflow(workflow: WorkflowOverrides): Promise<void>;

  listDocuments(taskId: string): Promise<DocumentMeta[]>;
  readDocument(taskId: string, name: string): Promise<string | null>;
  writeDocument(taskId: string, name: string, content: string): Promise<DocumentMeta>;
  deleteDocument(taskId: string, name: string): Promise<void>;

  /**
   * The history of a task (ADR-0030): methods that add or read, and none that change or remove.
   * Every record is created once and never rewritten; numbers are per task and continue after
   * the highest one, a file that cannot be read included. The callers hold the lock of the task.
   * A file that cannot be read is left out of the lists and reported by `readIssues`.
   */
  appendVersion(taskId: string, input: NewVersion): Promise<TaskVersion>;
  listVersions(taskId: string): Promise<TaskVersion[]>;
  readVersion(taskId: string, number: number): Promise<TaskVersion | null>;
  beginCheck(taskId: string, input: NewCheckBegin): Promise<CheckBegin>;
  /**
   * Refuses with `CHECK_NOT_FOUND`, or `CHECK_ALREADY_FINAL` when it has a report or an end, or,
   * for a research, when a markdown of other bytes was written already. A report of the other
   * kind, or one over a limit, is `INVALID_CHECK_REPORT` and writes nothing.
   */
  writeCheckReport(taskId: string, number: number, input: NewCheckReport): Promise<CheckReport>;
  /** Refuses with `CHECK_NOT_FOUND`, or `CHECK_ALREADY_FINAL` when it has an end already. */
  endCheck(taskId: string, number: number, input: NewCheckEnd): Promise<CheckEnd>;
  listChecks(taskId: string): Promise<Check[]>;
  readCheck(taskId: string, number: number): Promise<Check | null>;
  /**
   * The markdown of a research report, exactly as written; null when the check does not exist,
   * has no published report with a markdown, or the file is not the one the record describes.
   * A markdown without its record is not a report (ADR-0030 R3).
   */
  readCheckMarkdown(taskId: string, number: number): Promise<string | null>;
  /** Refuses with `CHECK_NOT_FOUND`; whether it may be decided on is the caller's rule. */
  appendDecision(taskId: string, number: number, input: NewDecision): Promise<Decision>;

  /**
   * Topics and blocks (ADR-0032 §2–3). Their ids are global, monotonic and never reused, each
   * kind with a counter of its own, kept apart from the tasks'. A lost counter is recovered from
   * the ids that exist; when a topic cannot be read as well, creating a topic or a block refuses
   * with `ID_SEQUENCE_UNRECOVERABLE` and writes nothing (O-1). A topic that does not exist or
   * cannot be read is null, and a block for it is `TOPIC_NOT_FOUND`.
   */
  getTopic(id: string): Promise<Topic | null>;
  createTopic(input: NewTopic): Promise<Topic>;
  /** Appends the block to the end of its topic's blocks. */
  createBlock(topicId: string, input: NewBlock): Promise<Block>;
  /**
   * Writes (T84) are refused before anything is written, and the refusal changes no file and
   * no counter: `TOPIC_NOT_FOUND`, `BLOCK_NOT_FOUND` for a block the topic does not hold (a
   * block never moves between topics), and `INVALID_REQUEST` for an order that is not exactly
   * the blocks the topic holds. The ids of what is deleted stay used (ADR-0020), even when the
   * counters were lost; with them lost and a topic unreadable, a delete is refused with
   * `ID_SEQUENCE_UNRECOVERABLE`, as a create is.
   */
  updateTopic(id: string, patch: TopicPatch): Promise<Topic>;
  /**
   * Refused with `TOPIC_NOT_EMPTY` unless the topic has no blocks, an empty one included, and
   * no task is in it or in a block of it. A task file that cannot be read may be such a task,
   * so it refuses too. Checked in the same section as the delete, so a task cannot arrive
   * between the check and the write.
   */
  deleteTopic(id: string): Promise<void>;
  updateBlock(topicId: string, blockId: string, patch: NewBlock): Promise<Block>;
  /** `order` is every block id of the topic once; the topic is answered as it is stored then. */
  reorderBlocks(topicId: string, order: readonly string[]): Promise<Topic>;
  /** Refused with `BLOCK_NOT_EMPTY` while a task is in the block (a task that cannot be read counts). */
  deleteBlock(topicId: string, blockId: string): Promise<void>;

  listReports(): Promise<Report[]>;
  readReport(id: string): Promise<string | null>;
  writeReport(input: NewReport): Promise<Report>;
  deleteReport(id: string): Promise<void>;
}

/** Git is read-only in the MVP (ADR-0007). */
export interface GitReader {
  available(): Promise<boolean>;
  currentBranch(): Promise<{ name: string | null; detached: boolean }>;
  branches(): Promise<GitBranch[]>;
  status(): Promise<GitStatus>;
  commits(options: { ref?: string | undefined; limit: number }): Promise<GitCommit[]>;
  diff(options: {
    ref?: string | undefined;
    path?: string | undefined;
    staged?: boolean | undefined;
  }): Promise<GitDiff>;
}

export interface EventSink {
  publish(event: BoardEvent): void;
}
