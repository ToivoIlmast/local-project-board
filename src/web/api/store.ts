import type {
  BoardEvent,
  DocumentMeta,
  GitStatus,
  Project,
  Report,
  Task,
} from '../../contract/v1/index';
import type { BoardClient } from './client';
import { ApiError } from './errors';
import type { ConnectionStatus } from './events';

/**
 * What the board looks like right now. It is a mirror of the API and nothing else: every
 * field here is something a route answered or an event changed, so there is one truth and
 * the server owns it. UI state (which panel is open, what is typed in a form) is not here.
 */
export interface BoardState {
  phase: 'loading' | 'ready' | 'failed';
  /** Why the board could not be read at all; a failed change does not land here. */
  error?: ApiError | undefined;
  project?: Project | undefined;
  tasks: Task[];
  reports: Report[];
  /** Missing when git could not be read; the board itself keeps working (§17). */
  git?: GitStatus | undefined;
  /** By task id, for the tasks whose documents have been opened. */
  documents: Record<string, DocumentMeta[]>;
  connection: ConnectionStatus;
  /** Tasks with a change in flight. */
  busy: string[];
}

export interface Column {
  status: string;
  tasks: Task[];
}

export function emptyState(): BoardState {
  return {
    phase: 'loading',
    tasks: [],
    reports: [],
    documents: {},
    connection: 'connecting',
    busy: [],
  };
}

/**
 * The board after one event. Pure, and it replaces rather than appends: the same event
 * delivered twice — once as the answer to our own request, once over the stream — must
 * leave the board looking the same (§14).
 */
export function applyEvent(state: BoardState, event: BoardEvent): BoardState {
  switch (event.type) {
    case 'task.created':
    case 'task.updated':
      return { ...state, tasks: replaceById(state.tasks, event.task) };
    case 'task.deleted': {
      const { [event.taskId]: _gone, ...documents } = state.documents;
      return {
        ...state,
        tasks: state.tasks.filter((task) => task.id !== event.taskId),
        documents,
      };
    }
    case 'document.written': {
      const current = state.documents[event.document.taskId];
      // A task whose documents were never read has no list to add to, and inventing a
      // half-read one would show the user a list that is missing everything else.
      if (current === undefined) return state;
      const kept = current.filter((document) => document.name !== event.document.name);
      return {
        ...state,
        documents: {
          ...state.documents,
          [event.document.taskId]: [...kept, event.document].sort(byName),
        },
      };
    }
    case 'document.deleted': {
      const current = state.documents[event.taskId];
      if (current === undefined) return state;
      return {
        ...state,
        documents: {
          ...state.documents,
          [event.taskId]: current.filter((document) => document.name !== event.name),
        },
      };
    }
    case 'report.created':
      return {
        ...state,
        reports: [...state.reports.filter((report) => report.id !== event.report.id), event.report],
      };
    case 'report.deleted':
      return { ...state, reports: state.reports.filter((report) => report.id !== event.reportId) };
    case 'board.changed':
      // Files changed outside the server; the board must be read again, not patched.
      return state;
  }
}

/**
 * The columns of the board, in the order the board is configured with. A task whose status
 * is not one of them is not dropped: it is handed back separately so the page can say so
 * rather than quietly losing it (ADR-0022 in spirit).
 */
export function columnsOf(
  project: Project | undefined,
  tasks: Task[],
): { columns: Column[]; orphans: Task[] } {
  const statuses = project?.statuses ?? [];
  const known = new Set(statuses);
  return {
    columns: statuses.map((status) => ({
      status,
      tasks: tasks.filter((task) => task.status === status).sort(byRank),
    })),
    orphans: tasks.filter((task) => !known.has(task.status)),
  };
}

/** The order the server puts a column in: rank as plain text, ties broken by id (ADR-0011). */
function byRank(a: Task, b: Task): number {
  return compare(a.rank, b.rank) || compare(a.id, b.id);
}

function byName(a: DocumentMeta, b: DocumentMeta): number {
  return compare(a.name, b.name);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function replaceById(tasks: Task[], task: Task): Task[] {
  const index = tasks.findIndex((candidate) => candidate.id === task.id);
  if (index === -1) return [...tasks, task];
  return tasks.map((candidate, at) => (at === index ? task : candidate));
}

/** How many times a read of the board is repeated because it was overtaken by a change. */
const READ_ATTEMPTS = 3;

export interface BoardStore {
  getState(): BoardState;
  subscribe(listener: () => void): () => void;
  /** Read the whole board; also how the page recovers after a break in the stream. */
  load(): Promise<void>;
  createTask(input: Parameters<BoardClient['createTask']>[0]): Promise<Task>;
  updateTask(id: string, patch: Parameters<BoardClient['updateTask']>[1]): Promise<Task>;
  moveTask(id: string, move: Parameters<BoardClient['moveTask']>[1]): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  loadDocuments(taskId: string): Promise<void>;
  writeDocument(taskId: string, name: string, content: string): Promise<void>;
  deleteDocument(taskId: string, name: string): Promise<void>;
  deleteReport(id: string): Promise<void>;
  handleEvent(event: BoardEvent): Promise<void>;
  setConnection(status: ConnectionStatus): void;
}

/**
 * The board's server state, kept in one place and changed only by the server's answers and
 * its events. There is no optimistic guessing: a card moves when the board says it moved,
 * which is also why the page never has to undo anything (§18).
 */
export function createBoardStore(client: BoardClient): BoardStore {
  let state = emptyState();
  const listeners = new Set<() => void>();

  const set = (next: (current: BoardState) => BoardState): void => {
    state = next(state);
    for (const listener of [...listeners]) listener();
  };

  /**
   * How many things the server has told this store since it was made. A read of the whole
   * board is a photograph taken at one moment; this is how it finds out it was taken before
   * something the store has since been told, and so must not be put on the page.
   */
  let told = 0;

  const apply = (event: BoardEvent): void => {
    told += 1;
    set((current) => applyEvent(current, event));
  };

  /**
   * The whole board as the server has it now. A change the store was told of while this was
   * being read is newer than the photograph (a move that was answered while `git status`
   * was still running, say), so the photograph is taken again rather than shown: showing it
   * would put the card back where it was, and the person's focus with it. A few tries, then
   * what was read is used: every write makes the server publish `board.changed`, so a page
   * that could not catch up here is read again anyway.
   */
  async function readBoard(): Promise<Pick<BoardState, 'project' | 'tasks' | 'reports' | 'git'>> {
    for (let attempt = 1; ; attempt += 1) {
      const before = told;
      const [project, tasks, reports] = await Promise.all([
        client.project(),
        client.listTasks(),
        client.listReports(),
      ]);
      // Git is context, not the board: a repository that cannot be read hides nothing else.
      const git = await client.gitStatus().catch(() => undefined);
      if (told === before || attempt === READ_ATTEMPTS) return { project, tasks, reports, git };
    }
  }

  async function busy<T>(id: string, run: () => Promise<T>): Promise<T> {
    set((current) => ({ ...current, busy: [...current.busy, id] }));
    try {
      return await run();
    } finally {
      set((current) => ({ ...current, busy: current.busy.filter((waiting) => waiting !== id) }));
    }
  }

  const store: BoardStore = {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async load() {
      set((current) => ({
        ...current,
        phase: current.phase === 'ready' ? 'ready' : 'loading',
        error: undefined,
      }));
      try {
        const { project, tasks, reports, git } = await readBoard();
        set((current) => ({
          ...current,
          phase: 'ready',
          error: undefined,
          project,
          tasks,
          reports,
          git,
        }));
      } catch (error) {
        // A board that has been read once is not thrown away because a later read failed:
        // the page keeps showing what it last knew and says what happened (ADR-0025). Only
        // a board that was never read has nothing to show but the failure.
        set((current) => ({
          ...current,
          phase: current.project === undefined ? 'failed' : 'ready',
          error: asApiError(error),
        }));
        return;
      }
      // Whatever was open keeps its documents fresh after a full re-read.
      await Promise.all(
        Object.keys(state.documents).map((id) => store.loadDocuments(id).catch(() => undefined)),
      );
    },

    async createTask(input) {
      const task = await client.createTask(input);
      apply({ type: 'task.created', task });
      return task;
    },

    updateTask: (id, patch) =>
      busy(id, async () => {
        const task = await client.updateTask(id, patch);
        apply({ type: 'task.updated', task });
        return task;
      }),

    moveTask: (id, move) =>
      busy(id, async () => {
        const task = await client.moveTask(id, move);
        apply({ type: 'task.updated', task });
        return task;
      }),

    deleteTask: (id) =>
      busy(id, async () => {
        await client.deleteTask(id);
        apply({ type: 'task.deleted', taskId: id });
      }),

    async loadDocuments(taskId) {
      const documents = await client.listDocuments(taskId);
      set((current) => ({ ...current, documents: { ...current.documents, [taskId]: documents } }));
    },

    async writeDocument(taskId, name, content) {
      const document = await client.writeDocument(taskId, name, content);
      apply({ type: 'document.written', document });
    },

    async deleteDocument(taskId, name) {
      await client.deleteDocument(taskId, name);
      apply({ type: 'document.deleted', taskId, name });
    },

    async deleteReport(id) {
      await client.deleteReport(id);
      apply({ type: 'report.deleted', reportId: id });
    },

    async handleEvent(event) {
      if (event.type === 'board.changed') {
        await store.load();
        return;
      }
      apply(event);
    },

    setConnection(connection) {
      set((current) => ({ ...current, connection }));
    },
  };

  return store;
}

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(0, 'INTERNAL_ERROR', 'The board could not be read.');
}
