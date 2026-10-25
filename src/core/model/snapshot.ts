import { z } from 'zod';
import { documentNameSchema } from './document.js';
import { checkSchema, taskVersionSchema } from './history.js';
import { projectSchema } from './project.js';
import { reportSchema } from './report.js';
import { isoDateTimeSchema, taskIdSchema, taskSchema } from './task.js';
import { workflowOverridesSchema } from './workflow.js';

/**
 * A portable backup/export of a whole board (ADR-0009).
 * Not a persistence model: the source of truth is .board/ on disk.
 */
export const boardSnapshotSchema = z.strictObject({
  formatVersion: z.literal(3),
  exportedAt: isoDateTimeSchema,
  project: projectSchema.pick({ name: true, statuses: true, idPrefix: true }),
  /** Overrides of the board and its columns; the tasks carry their own (ADR-0028). */
  workflow: workflowOverridesSchema,
  tasks: z.array(taskSchema),
  documents: z.array(
    z.strictObject({ taskId: taskIdSchema, name: documentNameSchema, content: z.string() }),
  ),
  reports: z.array(reportSchema.extend({ content: z.string() })),
  /** The versions and the checks of every task, as they are stored (ADR-0030 §8). */
  history: z.array(
    z.strictObject({
      taskId: taskIdSchema,
      versions: z.array(taskVersionSchema),
      checks: z.array(checkSchema),
      /**
       * The text of each research report, which the records describe by size and hash only
       * (ADR-0030 R3). Absent when the task has none.
       */
      reportMarkdown: z
        .array(z.strictObject({ check: z.int().min(1), content: z.string() }))
        .optional(),
    }),
  ),
});

export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>;
