import { BoardError } from '../errors.js';
import type { Task } from '../model/task.js';
import type { WorkflowFlagOverrides } from '../model/workflow.js';
import type { EventSink, Storage } from '../ports.js';
import { compareByRank, rankForPosition, type Position } from '../rules/rank.js';
import { assertKnownStatus } from '../rules/status.js';

export interface TaskServiceOptions {
  storage: Storage;
  events: EventSink;
  /** The configured statuses, in board order. */
  statuses: string[];
}

export interface CreateTaskInput {
  title: string;
  status?: string | undefined;
  body?: string | undefined;
  labels?: string[] | undefined;
  branch?: string | undefined;
  workflow?: WorkflowFlagOverrides | undefined;
}

export interface UpdateTaskInput {
  title?: string | undefined;
  status?: string | undefined;
  body?: string | undefined;
  labels?: string[] | undefined;
  branch?: string | null | undefined;
  /** An object replaces the task's overrides whole; null removes them. */
  workflow?: WorkflowFlagOverrides | null | undefined;
}

export interface MoveTaskInput extends Position {
  status: string;
}

export interface TaskService {
  list(): Promise<Task[]>;
  get(id: string): Promise<Task>;
  create(input: CreateTaskInput): Promise<Task>;
  update(id: string, patch: UpdateTaskInput): Promise<Task>;
  move(id: string, move: MoveTaskInput): Promise<Task>;
  remove(id: string): Promise<void>;
}

export function createTaskService({ storage, events, statuses }: TaskServiceOptions): TaskService {
  async function column(status: string): Promise<Task[]> {
    return (await storage.listTasks()).filter((task) => task.status === status);
  }

  async function require(id: string): Promise<Task> {
    const task = await storage.getTask(id);
    if (!task) throw new BoardError('TASK_NOT_FOUND', `Task "${id}" does not exist.`, { id });
    return task;
  }

  return {
    async list() {
      const order = new Map(statuses.map((status, index) => [status, index]));
      // A status that is no longer configured sorts last rather than disappearing.
      const rank = (task: Task): number => order.get(task.status) ?? statuses.length;
      return (await storage.listTasks()).sort((a, b) => rank(a) - rank(b) || compareByRank(a, b));
    },

    get: require,

    async create(input) {
      const status = input.status ?? firstStatus(statuses);
      assertKnownStatus(status, statuses);
      const task = await storage.createTask({
        title: input.title,
        status,
        rank: rankForPosition(await column(status), {}),
        body: input.body ?? '',
        labels: input.labels ?? [],
        branch: input.branch,
        workflow: input.workflow,
      });
      events.publish({ type: 'task.created', task });
      return task;
    },

    async update(id, patch) {
      const current = await require(id);
      if (patch.status !== undefined) assertKnownStatus(patch.status, statuses);
      const movedToAnotherColumn = patch.status !== undefined && patch.status !== current.status;
      const task = await storage.updateTask(id, {
        ...patch,
        // A plain status change lands at the end of the new column; /move places it precisely.
        ...(movedToAnotherColumn
          ? { rank: rankForPosition(await column(patch.status as string), {}, id) }
          : {}),
      });
      events.publish({ type: 'task.updated', task });
      return task;
    },

    async move(id, { status, after, before }) {
      await require(id);
      assertKnownStatus(status, statuses);
      const task = await storage.updateTask(id, {
        status,
        rank: rankForPosition(await column(status), { after, before }, id),
      });
      events.publish({ type: 'task.updated', task });
      return task;
    },

    async remove(id) {
      await storage.deleteTask(id);
      events.publish({ type: 'task.deleted', taskId: id });
    },
  };
}

function firstStatus(statuses: string[]): string {
  const status = statuses[0];
  if (status === undefined) throw new BoardError('UNKNOWN_STATUS', 'The board has no statuses.');
  return status;
}
