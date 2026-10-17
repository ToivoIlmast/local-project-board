import { BoardError } from '../errors.js';
import type { Task } from '../model/task.js';
import type { AiRun } from '../model/aiRun.js';
import type { FromCheck } from '../model/history.js';
import type { TaskWorkflowOverrides } from '../model/workflow.js';
import type { EventSink, Storage } from '../ports.js';
import { applyContentPatch, changedFields, contentOf } from '../rules/history.js';
import { compareByRank, rankForPosition, type Position } from '../rules/rank.js';
import { assertKnownStatus } from '../rules/status.js';
import { assertContentHash, assertFromCheck, syncHistory } from './taskHistory.js';
import { createTaskLocks, type TaskLocks } from './taskLocks.js';

export interface TaskServiceOptions {
  storage: Storage;
  events: EventSink;
  /** The configured statuses, in board order. */
  statuses: string[];
  /** The locks of the AI run lifecycle, shared with the aiRun service (T45). */
  locks?: TaskLocks | undefined;
}

export interface CreateTaskInput {
  title: string;
  status?: string | undefined;
  body?: string | undefined;
  labels?: string[] | undefined;
  branch?: string | undefined;
  workflow?: TaskWorkflowOverrides | undefined;
}

export interface UpdateTaskInput {
  title?: string | undefined;
  status?: string | undefined;
  body?: string | undefined;
  labels?: string[] | undefined;
  branch?: string | null | undefined;
  /** An object replaces the task's overrides whole; null removes them. */
  workflow?: TaskWorkflowOverrides | null | undefined;
  /** What the agent reports about its run; an object replaces it whole, null removes it. */
  aiRun?: AiRun | null | undefined;
  /**
   * The `contentHash` of the content the change is based on; a content that hashes differently
   * is refused and nothing is written (ADR-0030 §4). Absent means last-write-wins.
   */
  ifContentHash?: string | undefined;
  /** Where the new content came from; recorded on the version it makes (ADR-0030 §7). */
  fromCheck?: FromCheck | undefined;
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

export function createTaskService({
  storage,
  events,
  statuses,
  locks = createTaskLocks(),
}: TaskServiceOptions): TaskService {
  async function column(status: string): Promise<Task[]> {
    return (await storage.listTasks()).filter((task) => task.status === status);
  }

  async function require(id: string): Promise<Task> {
    const task = await storage.getTask(id);
    if (!task) throw new BoardError('TASK_NOT_FOUND', `Task "${id}" does not exist.`, { id });
    return task;
  }

  /** Who is told what a write did: the versions it appended, then the task itself. */
  function announce(task: Task, versions: readonly { number: number }[]): void {
    for (const version of versions) {
      events.publish({ type: 'version.created', taskId: task.id, number: version.number });
    }
    events.publish({ type: 'task.updated', task });
  }

  /**
   * One change of a task, inside the lock of the task (ADR-0030 §3): read, every precondition,
   * sync, write. A refusal anywhere before the write leaves nothing behind.
   */
  async function change(id: string, input: UpdateTaskInput): Promise<Task> {
    const { ifContentHash, fromCheck, ...patch } = input;
    const current = await require(id);
    const before = contentOf(current);

    // The preconditions, in the order of the ADR: the content hash, then the check.
    await assertContentHash(storage, id, before, ifContentHash);
    if (fromCheck !== undefined) {
      await assertFromCheck(storage, id, fromCheck, before, ifContentHash);
    }

    // A run the runner began has a runId, working or over: clearing it would start runId again
    // from 1, and a late end or report of it could then touch a new run with the same runId.
    // One an agent reported itself (before T31) has none to keep, and stays a thing the person
    // may clear.
    if (patch.aiRun === null && current.aiRun?.runId !== undefined) {
      throw new BoardError(
        'AI_RUN_NOT_CLEARABLE',
        `The AI run of task "${id}" has a runId and cannot be cleared; the next run replaces it.`,
        { id, runId: current.aiRun.runId },
      );
    }
    if (patch.status !== undefined) assertKnownStatus(patch.status, statuses);
    const movedToAnotherColumn = patch.status !== undefined && patch.status !== current.status;

    const after = applyContentPatch(before, patch);
    const changed = changedFields(before, after);

    // Sync: history ends at what is on disk before the new content is written.
    const appended = changed.length > 0 ? await syncHistory(storage, id, before) : [];
    const task = await storage.updateTask(id, {
      ...patch,
      // A plain status change lands at the end of the new column; /move places it precisely.
      ...(movedToAnotherColumn
        ? { rank: rankForPosition(await column(patch.status as string), {}, id) }
        : {}),
    });
    if (changed.length > 0) {
      // After task.md, so a crash in between leaves the content ahead of history, to be found
      // as `external` by the next sync, and never a version that did not become the task.
      const version = await storage.appendVersion(id, {
        source: 'edit',
        changed,
        snapshot: after,
        ...(fromCheck === undefined ? {} : { fromCheck }),
      });
      appended.push(version);
    }
    announce(task, appended);
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
      // The first version, under the lock of the new task. If it cannot be written the task
      // still exists, and the next sync records its content as a `baseline`.
      await locks.run(task.id, () =>
        storage.appendVersion(task.id, {
          source: 'create',
          changed: [],
          snapshot: contentOf(task),
        }),
      );
      // `task.created` is the news; nobody has the history of a task that did not exist.
      events.publish({ type: 'task.created', task });
      return task;
    },

    update(id, patch) {
      // Clearing the run waits for its lifecycle, and is refused for any run with a runId: it
      // would hide a live run or start runId again from 1 (T45). A lost run is ended by abandon.
      // Content, a precondition and a check are written under the same lock, taken once, so the
      // precondition and the write cannot be parted (ADR-0030 §3). Anything else stays outside.
      const locked =
        patch.aiRun === null ||
        patch.title !== undefined ||
        patch.body !== undefined ||
        patch.labels !== undefined ||
        patch.ifContentHash !== undefined ||
        patch.fromCheck !== undefined;
      return locked ? locks.run(id, () => change(id, patch)) : change(id, patch);
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
      // Its history goes with it (ADR-0030 §8), after whatever is writing to it has finished.
      await locks.run(id, () => storage.deleteTask(id));
      events.publish({ type: 'task.deleted', taskId: id });
    },
  };
}

function firstStatus(statuses: string[]): string {
  const status = statuses[0];
  if (status === undefined) throw new BoardError('UNKNOWN_STATUS', 'The board has no statuses.');
  return status;
}
