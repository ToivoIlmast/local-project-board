import { z } from 'zod';
import { isTaskIdPrefix } from '../rules/ids.js';

export const statusesSchema = z
  .array(z.string().min(1))
  .min(1)
  .refine((s) => new Set(s).size === s.length, 'Statuses must be unique');

export const taskIdPrefixSchema = z
  .string()
  .refine(isTaskIdPrefix, 'Must be 1–10 upper-case letters, e.g. "T"');

export const projectSchema = z.strictObject({
  name: z.string().min(1),
  /** Absolute path of the board root (the main worktree). */
  root: z.string().min(1),
  statuses: statusesSchema,
  idPrefix: taskIdPrefixSchema,
  storage: z.strictObject({ provider: z.string().min(1) }),
  git: z.strictObject({
    available: z.boolean(),
    branch: z.string().optional(),
    detached: z.boolean().optional(),
  }),
  version: z.string().min(1),
});

export type Project = z.infer<typeof projectSchema>;
