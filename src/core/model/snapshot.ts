import { z } from 'zod';
import { documentNameSchema } from './document.js';
import { projectSchema } from './project.js';
import { reportSchema } from './report.js';
import { isoDateTimeSchema, taskIdSchema, taskSchema } from './task.js';

/**
 * A portable backup/export of a whole board (ADR-0009).
 * Not a persistence model: the source of truth is .board/ on disk.
 */
export const boardSnapshotSchema = z.strictObject({
  formatVersion: z.literal(1),
  exportedAt: isoDateTimeSchema,
  project: projectSchema.pick({ name: true, statuses: true, idPrefix: true }),
  tasks: z.array(taskSchema),
  documents: z.array(
    z.strictObject({ taskId: taskIdSchema, name: documentNameSchema, content: z.string() }),
  ),
  reports: z.array(reportSchema.extend({ content: z.string() })),
});

export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>;
