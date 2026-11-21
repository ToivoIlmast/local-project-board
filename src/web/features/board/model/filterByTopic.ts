import type { Task } from '../../../../contract/v1/index';
import { isArchived, withoutArchived } from '../../../api/index';

/** The value of `?topic=` for the tasks that belong to no topic. */
export const NO_TOPIC = 'none';

/**
 * The tasks the board shows for a topic filter: `null` is All, `none` the tasks with no topic,
 * anything else the tasks whose `topic` is that id. Membership is the task's own `topic`, never
 * worked out from its block. An id that matches nothing gives nothing — it is not All — so the
 * page can say why the board is empty. All is the very array it was given when none is archived; the rest is new.
 */
export function filterByTopic(tasks: Task[], filter: string | null): Task[] {
  // An archived task is not on the board, so it is in no topic's count either (T10).
  const shown = tasks.some(isArchived) ? withoutArchived(tasks) : tasks;
  if (filter === null) return shown;
  if (filter === NO_TOPIC) return shown.filter((task) => task.topic === undefined);
  return shown.filter((task) => task.topic === filter);
}
