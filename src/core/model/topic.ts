import { z } from 'zod';
import { isBlockId, isTopicId } from '../rules/ids.js';

export const topicIdSchema = z.string().refine(isTopicId, 'Invalid topic id');
export const blockIdSchema = z.string().refine(isBlockId, 'Invalid block id');
const nonBlank = z.string().regex(/\S/, 'Must not be blank');

export const blockSchema = z.strictObject({
  id: blockIdSchema,
  title: nonBlank,
});

/** A topic and its blocks, in their order (ADR-0032 §3). It has no status (O-4). */
export const topicSchema = z.strictObject({
  id: topicIdSchema,
  title: nonBlank,
  /** Markdown. */
  body: z.string(),
  blocks: z.array(blockSchema),
});

export type Block = z.infer<typeof blockSchema>;
export type Topic = z.infer<typeof topicSchema>;
