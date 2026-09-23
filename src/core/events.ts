import { z } from 'zod';
import { documentMetaSchema } from './model/document.js';
import { reportSchema } from './model/report.js';
import { taskSchema } from './model/task.js';
import { documentNameSchema } from './model/document.js';
import { reportIdSchema } from './model/report.js';
import { taskIdSchema } from './model/task.js';

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
  /** Something changed on disk outside the server; the client refetches. */
  z.strictObject({ type: z.literal('board.changed') }),
]);

export type BoardEvent = z.infer<typeof boardEventSchema>;
