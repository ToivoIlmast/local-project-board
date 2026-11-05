import type { Task } from '../../../../contract/v1/index';

/** The value of `?topic=` for the tasks that belong to no topic. */
export const NO_TOPIC = 'none';

/**
 * The tasks the board shows for a topic filter: `null` is All, `none` the tasks with no topic,
 * anything else the tasks whose `topic` is that id. Membership is the task's own `topic`, never
 * worked out from its block. An id that matches nothing gives nothing — it is not All — so the
 * page can say why the board is empty. All is the very array it was given; the rest is new.
 */
export function filterByTopic(tasks: Task[], filter: string | null): Task[] {
  if (filter === null) return tasks;
  if (filter === NO_TOPIC) return tasks.filter((task) => task.topic === undefined);
  return tasks.filter((task) => task.topic === filter);
}
