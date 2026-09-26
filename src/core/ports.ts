import type { BoardEvent } from './events.js';
import type {
  DocumentMeta,
  GitBranch,
  GitCommit,
  GitDiff,
  GitStatus,
  Report,
  Task,
  WorkflowFlagOverrides,
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
  workflow?: WorkflowFlagOverrides | undefined;
  extra?: Record<string, unknown> | undefined;
}

/**
 * Only the given fields change. `branch: null` clears the branch; `workflow: null` clears all of
 * the task's workflow overrides, and a `workflow` object replaces them whole, as `labels` does.
 */
export interface TaskPatch {
  title?: string | undefined;
  status?: string | undefined;
  rank?: string | undefined;
  body?: string | undefined;
  labels?: string[] | undefined;
  branch?: string | null | undefined;
  workflow?: WorkflowFlagOverrides | null | undefined;
  extra?: Record<string, unknown> | undefined;
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
  /** Allocates the id atomically; an id is never reused (ADR-0020). */
  createTask(input: NewTask): Promise<Task>;
  updateTask(id: string, patch: TaskPatch): Promise<Task>;
  /** Deletes the task and its documents. */
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
