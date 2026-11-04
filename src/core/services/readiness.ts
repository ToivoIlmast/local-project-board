import { BoardError } from '../errors.js';
import type { Task } from '../model/task.js';
import type { Topic } from '../model/topic.js';
import type { Storage } from '../ports.js';
import { readiness, type BlockingReason } from '../rules/readiness.js';

/** The board as it was read once, and the reasons of each of its tasks, by id. */
export interface BoardReadiness {
  tasks: Task[];
  reasons: Record<string, BlockingReason[]>;
}

/**
 * Readiness of the whole board, from one read of it (ADR-0032 §7): the tasks, the topics they
 * name, and what could not be read. Nothing is kept; every caller reads afresh.
 */
export async function readBoardReadiness(
  storage: Storage,
  statuses: readonly string[],
): Promise<BoardReadiness> {
  const [tasks, readIssues] = await Promise.all([storage.listTasks(), storage.readIssues()]);
  const named = [...new Set(tasks.flatMap((task) => task.topic ?? []))];
  const topics = (await Promise.all(named.map((id) => storage.getTopic(id)))).filter(
    (topic): topic is Topic => topic !== null,
  );
  return { tasks, reasons: readiness({ tasks, topics, readIssues, statuses }) };
}

/**
 * The reasons of one task, read now. A task that is not on the board as it was read is
 * `TASK_NOT_FOUND`: there is nothing to tell ready, so nothing may start.
 */
export async function reasonsOf(
  storage: Storage,
  statuses: readonly string[],
  id: string,
): Promise<BlockingReason[]> {
  const reasons = (await readBoardReadiness(storage, statuses)).reasons[id];
  if (reasons === undefined) {
    throw new BoardError('TASK_NOT_FOUND', `Task "${id}" does not exist.`, { id });
  }
  return reasons;
}

/** A task that may not be started yet, with the reasons as codes; the client words them. */
export function taskBlocked(id: string, reasons: readonly BlockingReason[]): BoardError {
  return new BoardError(
    'TASK_BLOCKED',
    `Task "${id}" is blocked and cannot be started yet: ${reasons.map(describe).join('; ')}.`,
    { id, reasons },
  );
}

/** One reason in a few words, for the message of the error; the codes stay in its details. */
function describe(reason: BlockingReason): string {
  switch (reason.code) {
    case 'task-not-done':
      return `${reason.task} is not done`;
    case 'task-missing':
      return `${reason.task} does not exist`;
    case 'task-unreadable':
      return `${reason.task} cannot be read`;
    case 'topic-missing':
      return `topic ${reason.topic} does not exist`;
    case 'topic-unreadable':
      return `topic ${reason.topic} cannot be read`;
    case 'block-missing':
      return `block ${reason.block} is not in topic ${reason.topic}`;
    case 'block-incomplete':
      return `block ${reason.block} has tasks that are not done (${reason.tasks.join(', ')})`;
    case 'block-empty':
      return `block ${reason.block} has no tasks`;
    case 'block-order-unknown':
      return `it is not known whether earlier blocks are done: ${reason.tasks.join(', ')} cannot be read`;
    case 'cycle':
      return `it is in a dependency cycle (${reason.tasks.join(', ')})`;
    case 'config':
      return `the board has no "${reason.status}" status`;
  }
}
