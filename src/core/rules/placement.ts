import { BoardError } from '../errors.js';
import type { Task } from '../model/task.js';
import type { Topic } from '../model/topic.js';
import { idNumber, isBlockId, isTaskId, isTopicId } from './ids.js';
import { findCycles } from './readiness.js';

/** What of a task's place a write brings: only what it names is checked. */
export interface PlacementWrite {
  topic?: string | null | undefined;
  block?: string | null | undefined;
  dependsOn?: string[] | null | undefined;
}

/** The place a task ends up in, with the fields a write leaves alone taken from the task. */
export interface Placement {
  topic?: string | undefined;
  block?: string | undefined;
}

/** The tasks a `dependsOn` is judged against, as the board is read now. */
export interface DependencyBoard {
  /** The tasks that could be read, in the order of the board. */
  tasks: readonly Pick<Task, 'id' | 'dependsOn'>[];
  /** The ids of the tasks whose task.md cannot be read. */
  unreadable: readonly string[];
}

/**
 * Refuses a place that is not whole, with `INVALID_PLACEMENT`: a topic that does not exist or
 * cannot be read, a block without a topic, or a block the topic does not hold. A `dependsOn` that
 * is not in the form of the task ids of the board, a block id included, is `INVALID_DEPENDENCY`.
 * Checked by the provider inside the section that writes, because it holds the topics; whether
 * the tasks named exist and make a cycle is `assertDependencies` (ADR-0032 §3–4, T85).
 *
 * A write that names neither `topic` nor `block` leaves them unchecked, and so does one without
 * `dependsOn`: a board of an earlier version may hold a place that is not whole, and a task that
 * is only renamed must stay writable.
 */
export async function assertPlacement(
  write: PlacementWrite,
  current: Placement,
  idPrefix: string,
  getTopic: (id: string) => Promise<Topic | null>,
): Promise<void> {
  if (write.dependsOn) {
    const bad = write.dependsOn.find((id) => !isTaskId(id) || idNumber(idPrefix, id) === null);
    if (bad !== undefined) {
      throw new BoardError(
        'INVALID_DEPENDENCY',
        `"${bad}" in dependsOn is not a task id of this board (prefix "${idPrefix}").`,
        { dependsOn: bad, idPrefix },
      );
    }
  }
  if (write.topic === undefined && write.block === undefined) return;

  const topic = write.topic === undefined ? current.topic : (write.topic ?? undefined);
  const block = write.block === undefined ? current.block : (write.block ?? undefined);
  if (topic === undefined) {
    if (block === undefined) return;
    throw new BoardError('INVALID_PLACEMENT', `Block "${block}" needs a topic.`, { block });
  }
  const held = isTopicId(topic) ? await getTopic(topic) : null;
  if (held === null) {
    throw new BoardError(
      'INVALID_PLACEMENT',
      `Topic "${topic}" does not exist or cannot be read.`,
      { topic },
    );
  }
  if (block === undefined) return;
  if (!isBlockId(block) || !held.blocks.some((candidate) => candidate.id === block)) {
    throw new BoardError(
      'INVALID_PLACEMENT',
      `Block "${block}" does not belong to topic "${topic}".`,
      { topic, block },
    );
  }
}

/**
 * Refuses a `dependsOn` of the task `taskId` that names a task the board cannot read, or that
 * would put `taskId` in a cycle (ADR-0032 §4, T85); the cycle is found by `findCycles`, the one
 * readiness uses. `board` is read only when `dependsOn` names a task, and by the caller inside the
 * section that writes, so no other write comes between the check and the write.
 *
 * - A task that does not exist, a deleted one included, is `INVALID_DEPENDENCY`.
 * - So is a task whose file cannot be read, and one that leads to such a task through the
 *   dependencies of the board: its own dependencies are unknown, so a cycle through it cannot be
 *   ruled out (fail-closed, PHILOSOPHY §10).
 * - A cycle that `taskId` would be in is `DEPENDENCY_CYCLE`, with its tasks in the order of the
 *   board. A cycle elsewhere, left by a hand edit, refuses no write that stays out of it.
 */
export async function assertDependencies(
  taskId: string,
  dependsOn: readonly string[] | null | undefined,
  board: () => Promise<DependencyBoard>,
): Promise<void> {
  if (!dependsOn || dependsOn.length === 0) return;
  const { tasks, unreadable } = await board();
  const known = new Set(tasks.map((task) => task.id));
  for (const id of dependsOn) {
    if (unreadable.includes(id)) {
      throw new BoardError(
        'INVALID_DEPENDENCY',
        `Task "${id}" in dependsOn cannot be read, so its own dependencies are unknown.`,
        { dependsOn: id, unreadable: id },
      );
    }
    if (!known.has(id)) {
      throw new BoardError('INVALID_DEPENDENCY', `Task "${id}" in dependsOn does not exist.`, {
        dependsOn: id,
      });
    }
  }

  // The board as it would be after the write, the task in its place in the order of the board.
  const written = { id: taskId, dependsOn: [...dependsOn] };
  const after = known.has(taskId)
    ? tasks.map((task) => (task.id === taskId ? written : task))
    : [...tasks, written];
  const cycle = findCycles(after).find((members) => members.includes(taskId));
  if (cycle !== undefined) {
    throw new BoardError(
      'DEPENDENCY_CYCLE',
      `dependsOn of task "${taskId}" would make a cycle: ${cycle.join(', ')}.`,
      { tasks: cycle },
    );
  }

  const reached = unreadableReached(after, dependsOn, unreadable);
  if (reached !== undefined) {
    throw new BoardError(
      'INVALID_DEPENDENCY',
      `dependsOn of task "${taskId}" leads to task "${reached.unreadable}", which cannot be read.`,
      reached,
    );
  }
}

/** The first dependency that leads, through the dependencies of `tasks`, to an unreadable task. */
function unreadableReached(
  tasks: readonly Pick<Task, 'id' | 'dependsOn'>[],
  from: readonly string[],
  unreadable: readonly string[],
): { dependsOn: string; unreadable: string } | undefined {
  if (unreadable.length === 0) return undefined;
  const edges = new Map(tasks.map((task) => [task.id, task.dependsOn ?? []]));
  for (const start of from) {
    const seen = new Set<string>([start]);
    const queue = [start];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (unreadable.includes(id)) return { dependsOn: start, unreadable: id };
      for (const next of edges.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }
  return undefined;
}
