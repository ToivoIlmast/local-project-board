import { z } from 'zod';
import { documentMetaSchema } from './model/document.js';
import { reportSchema } from './model/report.js';
import { taskSchema } from './model/task.js';
import { documentNameSchema } from './model/document.js';
import { reportIdSchema } from './model/report.js';
import { taskIdSchema } from './model/task.js';
import { workflowStateSchema } from './model/workflow.js';

/** What the server tells open clients. Delivered over SSE; the core does not know about HTTP. */
export const boardEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('task.created'), task: taskSchema }),
  z.strictObject({ type: z.literal('task.updated'), task: taskSchema }),
  z.strictObject({ type: z.literal('task.deleted'), taskId: taskIdSchema }),
  z.strictObject({ type: z.literal('document.written'), document: documentMetaSchema }),
  z.strictObject({
    type: z.literal('document.deleted'),
    taskId: taskIdSchema,
    name: documentNameSchema,
  }),
  z.strictObject({ type: z.literal('report.created'), report: reportSchema }),
  z.strictObject({ type: z.literal('report.deleted'), reportId: reportIdSchema }),
  /** The overrides of the board or of its columns changed; a task's own come as `task.updated`. */
  z.strictObject({ type: z.literal('workflow.updated'), workflow: workflowStateSchema }),
  /**
   * Something changed on disk; the client refetches. Mostly an edit made outside the server,
   * but the watcher also echoes the server's own writes (ADR-0019), so it may follow, or come
   * before, the event of a change the server made itself. Never the only sign of such a change.
   */
  z.strictObject({ type: z.literal('board.changed') }),
]);

export type BoardEvent = z.infer<typeof boardEventSchema>;
