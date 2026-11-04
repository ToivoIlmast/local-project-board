import type { BlockingReason } from '../../../../contract/v1/index';

/**
 * The words of the page for a reason not to start a task: the board sends codes with what they
 * are about, and the client says them (ADR-0032 §7).
 */
export function reasonText(reason: BlockingReason): string {
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
      return `block ${reason.block} is not done: ${reason.tasks.join(', ')}`;
    case 'block-empty':
      return `block ${reason.block} has no tasks`;
    case 'block-order-unknown':
      return `earlier blocks cannot be told done: ${reason.tasks.join(', ')} cannot be read`;
    case 'cycle':
      return `dependency cycle: ${reason.tasks.join(', ')}`;
    case 'config':
      return `the board has no "${reason.status}" status`;
  }
}
