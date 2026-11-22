import type { Task } from '../model/task.js';

/** Why a task is related to the current one; the highest priority first (T14). */
export type RelatedReason = 'dependency' | 'block' | 'topic' | 'dependent';

export interface RelatedEntry {
  task: Task;
  reason: RelatedReason;
}

export interface RelatedSelection {
  related: RelatedEntry[];
  /** How many tasks of block, topic and dependents did not fit under the limit. */
  omitted: number;
}

/** The most tasks taken from block, topic and dependents together; dependencies are never cut. */
export const RELATED_GROUP_LIMIT = 10;

/**
 * The tasks that matter for one task, by structured fields only: `dependsOn` (in its order),
 * then the same block, the rest of the same topic and the tasks that depend on this one, each
 * group in the order of `tasks` (the board's order, so by rank). A task appears once, with the
 * reason of the highest priority; the task itself never does. Dependencies of dependencies are
 * not followed. A dependency that is not among `tasks` (unreadable, missing) is skipped.
 * Pure: the same input gives the same answer.
 */
export function selectRelatedTasks(current: Task, tasks: readonly Task[]): RelatedSelection {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set<string>([current.id]);
  const direct: RelatedEntry[] = [];
  for (const id of current.dependsOn ?? []) {
    const task = byId.get(id);
    if (task === undefined || seen.has(id)) continue;
    seen.add(id);
    direct.push({ task, reason: 'dependency' });
  }

  const group: RelatedEntry[] = [];
  const take = (reason: RelatedReason, matches: (task: Task) => boolean): void => {
    for (const task of tasks) {
      if (seen.has(task.id) || !matches(task)) continue;
      seen.add(task.id);
      group.push({ task, reason });
    }
  };
  if (current.topic !== undefined) {
    if (current.block !== undefined) {
      take('block', (task) => task.topic === current.topic && task.block === current.block);
    }
    take('topic', (task) => task.topic === current.topic);
  }
  take('dependent', (task) => task.dependsOn?.includes(current.id) === true);

  return {
    related: [...direct, ...group.slice(0, RELATED_GROUP_LIMIT)],
    omitted: Math.max(0, group.length - RELATED_GROUP_LIMIT),
  };
}
