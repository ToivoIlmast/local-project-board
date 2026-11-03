import { z } from 'zod';
import { isTaskId } from '../rules/ids.js';
import { isValidRank } from '../rules/rank.js';
import { aiRunSchema } from './aiRun.js';
import { blockIdSchema, topicIdSchema } from './topic.js';
import { taskWorkflowSchema } from './workflow.js';

export const taskIdSchema = z.string().refine(isTaskId, 'Invalid task id');
export const isoDateTimeSchema = z.iso.datetime();
const nonBlank = z.string().regex(/\S/, 'Must not be blank');

export const taskSchema = z
  .strictObject({
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
    /** This task's overrides of the AI workflow settings; only what is set (ADR-0028). */
    workflow: taskWorkflowSchema.optional(),
    /** What the last agent on this task reported about its run (T27). */
    aiRun: aiRunSchema.optional(),
    /** Where the task is placed (ADR-0032 §3). None of the three is content: no version (ADR-0030 §1). */
    topic: topicIdSchema.optional(),
    /** Only together with `topic`; that the topic holds the block is checked by the storage. */
    block: blockIdSchema.optional(),
    /** Tasks this one waits for, in the form of `tasks.idPrefix`, which the storage checks. */
    dependsOn: z.array(taskIdSchema).optional(),
    createdAt: isoDateTimeSchema,
    /** Updates are last-write-wins (ADR-0018). */
    updatedAt: isoDateTimeSchema,
    /** Unknown fields from storage, kept as they are. */
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((task) => task.block === undefined || task.topic !== undefined, {
    path: ['block'],
    message: 'A block needs a topic',
  });

export type Task = z.infer<typeof taskSchema>;
