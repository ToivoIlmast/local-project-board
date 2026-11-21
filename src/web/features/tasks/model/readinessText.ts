import type { BlockingReason } from '../../../../contract/v1/index';
import { taskT } from '../i18n/details';

/**
 * The words of the page for a reason not to start a task: the board sends codes with what they
 * are about, and the client says them (ADR-0032 §7), in the language shown. Ids stay as they are.
 */
export function reasonText(reason: BlockingReason, archived?: ReadonlySet<string>): string {
  switch (reason.code) {
    case 'task-not-done':
      // A task that is in the archive keeps its status, so it holds this one until it is restored.
      if (archived?.has(reason.task) === true) {
        return taskT('reason.task-archived', { task: reason.task });
      }
      return taskT(`reason.${reason.code}`, { task: reason.task });
    case 'task-missing':
    case 'task-unreadable':
      return taskT(`reason.${reason.code}`, { task: reason.task });
    case 'topic-missing':
    case 'topic-unreadable':
      return taskT(`reason.${reason.code}`, { topic: reason.topic });
    case 'block-missing':
      return taskT('reason.block-missing', { block: reason.block, topic: reason.topic });
    case 'block-incomplete':
      return taskT('reason.block-incomplete', {
        block: reason.block,
        tasks: reason.tasks.join(', '),
      });
    case 'block-empty':
      return taskT('reason.block-empty', { block: reason.block });
    case 'block-order-unknown':
      return taskT('reason.block-order-unknown', { tasks: reason.tasks.join(', ') });
    case 'cycle':
      return taskT('reason.cycle', { tasks: reason.tasks.join(', ') });
    case 'config':
      return taskT('reason.config', { status: reason.status });
  }
}
