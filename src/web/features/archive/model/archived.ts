import type { Task } from '../../../../contract/v1/index';
import { isArchived } from '../../../api/index';

/** The archived tasks, the last archived first; ties are broken by id so the order is stable. */
export function archivedNewestFirst(tasks: readonly Task[]): Task[] {
  return tasks
    .filter(isArchived)
    .sort(
      (a, b) =>
        (b.archived?.at ?? '').localeCompare(a.archived?.at ?? '') || a.id.localeCompare(b.id),
    );
}
