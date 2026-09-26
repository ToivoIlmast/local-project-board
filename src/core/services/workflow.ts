import { BoardError } from '../errors.js';
import type { EffectiveWorkflow, WorkflowOverrides, WorkflowState } from '../model/workflow.js';
import type { EventSink, Storage } from '../ports.js';
import { defaultWorkflow, findWorkflowIssues, resolveWorkflow } from '../rules/workflow.js';

export interface WorkflowServiceOptions {
  storage: Storage;
  events: EventSink;
  /** The configured statuses, in board order. */
  statuses: string[];
}

export interface WorkflowService {
  /** The overrides of the board and of its columns, next to the defaults they lie over. */
  read(): Promise<WorkflowState>;
  /** Replaces the overrides of the board and of its columns whole (last-write-wins, ADR-0018). */
  replace(overrides: WorkflowOverrides): Promise<WorkflowState>;
  /** What one task runs with, computed now by `resolveWorkflow` and stored nowhere. */
  forTask(id: string): Promise<EffectiveWorkflow>;
}

/**
 * The API's view of the model of ADR-0028. It adds no rule of its own: the merge is
 * `resolveWorkflow`, the statuses are checked by `findWorkflowIssues` (the same check that makes
 * the markdown provider report an override of a status the board does not have), and the only
 * thing ever written is what the caller sent, never a computed value.
 */
export function createWorkflowService({
  storage,
  events,
  statuses,
}: WorkflowServiceOptions): WorkflowService {
  async function state(): Promise<WorkflowState> {
    const { board, statuses: columns } = await storage.readWorkflow();
    return { defaults: defaultWorkflow(statuses), board, statuses: columns };
  }

  return {
    read: state,

    async replace(overrides) {
      const issues = findWorkflowIssues(overrides, statuses);
      if (issues.length > 0) {
        throw new BoardError('UNKNOWN_STATUS', issues.join(' '), {
          issues,
          allowed: [...statuses],
        });
      }
      await storage.writeWorkflow(overrides);
      const written = await state();
      events.publish({ type: 'workflow.updated', workflow: written });
      return written;
    },

    async forTask(id) {
      const task = await storage.getTask(id);
      if (!task) throw new BoardError('TASK_NOT_FOUND', `Task "${id}" does not exist.`, { id });
      const { board, statuses: columns } = await storage.readWorkflow();
      return resolveWorkflow(
        defaultWorkflow(statuses),
        board,
        // A status is a key, not a property: "constructor" is not a column.
        Object.hasOwn(columns, task.status) ? columns[task.status] : undefined,
        task.workflow,
      );
    },
  };
}
