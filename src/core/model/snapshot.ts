import { z } from 'zod';
import { documentNameSchema } from './document.js';
import { checkSchema, taskVersionSchema } from './history.js';
import { projectSchema } from './project.js';
import { reportSchema } from './report.js';
import { isoDateTimeSchema, taskIdSchema, taskSchema, type Task } from './task.js';
import { topicSchema, type Topic } from './topic.js';
import { workflowOverridesSchema } from './workflow.js';

/**
 * A portable backup/export of a whole board (ADR-0009).
 * Not a persistence model: the source of truth is .board/ on disk.
 */
export const boardSnapshotV3Schema = z.strictObject({
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

const counter = z.int().min(0);

/** v3 with the topics and the counters of their ids (ADR-0032 §10). */
export const boardSnapshotV4Schema = boardSnapshotV3Schema
  .extend({
    formatVersion: z.literal(4),
    /** Every topic, with its title, body, unknown frontmatter fields and its blocks in order. */
    topics: z.array(topicSchema),
    /**
     * The counters of `sequence.json` as stored, not the highest ids: the ids of what was deleted
     * stay used (ADR-0020). Null when the board had none that could be read.
     */
    sequence: z.strictObject({ topicSequence: counter, blockSequence: counter }).nullable(),
  })
  .superRefine((snapshot, context) => {
    for (const message of danglingReferences(snapshot.tasks, snapshot.topics)) {
      context.addIssue({ code: 'custom', path: ['tasks'], message });
    }
  });

/** Reads every version an export may have; the board writes only the last one. */
export const boardSnapshotSchema = z.discriminatedUnion('formatVersion', [
  boardSnapshotV3Schema,
  boardSnapshotV4Schema,
]);

export type BoardSnapshotV3 = z.infer<typeof boardSnapshotV3Schema>;
/** What the board exports now. */
export type BoardSnapshot = z.infer<typeof boardSnapshotV4Schema>;

/**
 * Each `topic` or `block` of a task that the topics do not hold: a backup never refers to one it
 * does not hold (ADR-0032 §10). Empty when every reference resolves.
 */
export function danglingReferences(tasks: readonly Task[], topics: readonly Topic[]): string[] {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const messages: string[] = [];
  for (const task of tasks) {
    if (task.topic === undefined) {
      if (task.block !== undefined) {
        messages.push(`Task "${task.id}" names block "${task.block}" without a topic.`);
      }
      continue;
    }
    const topic = byId.get(task.topic);
    if (topic === undefined) {
      messages.push(`Task "${task.id}" names topic "${task.topic}", which is not exported.`);
    } else if (task.block !== undefined && !topic.blocks.some((b) => b.id === task.block)) {
      messages.push(
        `Task "${task.id}" names block "${task.block}", which topic "${task.topic}" does not hold.`,
      );
    }
  }
  return messages;
}
