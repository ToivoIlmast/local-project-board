import { BoardError } from '../errors.js';

export function isKnownStatus(status: string, statuses: readonly string[]): boolean {
  return statuses.includes(status);
}

export function assertKnownStatus(status: string, statuses: readonly string[]): void {
  if (!isKnownStatus(status, statuses)) {
    throw new BoardError('UNKNOWN_STATUS', `Unknown status "${status}".`, {
      status,
      allowed: [...statuses],
    });
  }
}

export interface StatusHolder {
  id: string;
  status: string;
}

export interface OrphanedStatus {
  status: string;
  taskIds: string[];
}

/** Tasks whose status is no longer configured, in the order the statuses first appear. */
export function findOrphanedStatuses(
  tasks: readonly StatusHolder[],
  statuses: readonly string[],
): OrphanedStatus[] {
  const orphaned = new Map<string, string[]>();
  for (const task of tasks) {
    if (isKnownStatus(task.status, statuses)) continue;
    const ids = orphaned.get(task.status) ?? [];
    ids.push(task.id);
    orphaned.set(task.status, ids);
  }
  return [...orphaned].map(([status, taskIds]) => ({ status, taskIds }));
}

/**
 * INVARIANT: a status may not be removed from the config while tasks still use it.
 * The board refuses to start rather than silently hiding those tasks.
 */
export function assertNoOrphanedStatuses(
  tasks: readonly StatusHolder[],
  statuses: readonly string[],
): void {
  const orphaned = findOrphanedStatuses(tasks, statuses);
  if (orphaned.length === 0) return;
  const lines = orphaned.map(({ status, taskIds }) => `  ${status}: ${describe(taskIds)}`);
  throw new BoardError(
    'ORPHANED_STATUSES',
    ['Tasks use statuses that are not configured:', ...lines].join('\n'),
    { orphaned, configured: [...statuses] },
  );
}

function describe(taskIds: readonly string[]): string {
  const shown = taskIds.slice(0, 5).join(', ');
  return taskIds.length > 5
    ? `${taskIds.length} tasks (${shown}, …)`
    : `${taskIds.length} ${taskIds.length === 1 ? 'task' : 'tasks'} (${shown})`;
}
