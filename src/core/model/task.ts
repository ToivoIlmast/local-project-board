import { z } from 'zod';
import { isTaskId } from '../rules/ids.js';
import { isValidRank } from '../rules/rank.js';

export const taskIdSchema = z.string().refine(isTaskId, 'Invalid task id');
export const isoDateTimeSchema = z.iso.datetime();
const nonBlank = z.string().regex(/\S/, 'Must not be blank');

export const taskSchema = z.strictObject({
  id: taskIdSchema,
  title: nonBlank,
  /** Checked against the configured statuses by `assertKnownStatus`. */
  status: z.string().min(1),
  /** Fractional index within the status column (ADR-0011). */
  rank: z.string().refine(isValidRank, 'Invalid rank'),
  /** Markdown. */
  body: z.string(),
  labels: z.array(z.string().min(1)),
  /** A soft link to a git branch; not validated against the repository. */
  branch: z.string().min(1).optional(),
  createdAt: isoDateTimeSchema,
  /** Updates are last-write-wins (ADR-0018). */
  updatedAt: isoDateTimeSchema,
  /** Unknown fields from storage, kept as they are. */
  extra: z.record(z.string(), z.unknown()).optional(),
});

export type Task = z.infer<typeof taskSchema>;
