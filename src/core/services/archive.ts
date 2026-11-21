import { BoardError } from '../errors.js';
import type { Task } from '../model/task.js';

/** What is refused of an archived task: a start, a move, another status (T3). Restore it first. */
export function taskArchived(id: string): BoardError {
  return new BoardError(
    'TASK_ARCHIVED',
    `Task "${id}" is archived. Restore it first; nothing can start on it, and its status stays.`,
    { id },
  );
}

/** Throws `TASK_ARCHIVED` for an archived task. */
export function assertNotArchived(task: Pick<Task, 'id' | 'archived'>): void {
  if (task.archived !== undefined) throw taskArchived(task.id);
}
