import { z } from 'zod';
import { isoDateTimeSchema } from './task.js';

/**
 * A ref is passed to the git binary, so it must never be readable as an option or a
 * second argument: no leading "-", no whitespace, no shell metacharacters (INVARIANT).
 */
export const gitRefSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/~^-]*$/, 'Invalid git ref');

export const gitPathSchema = z
  .string()
  .min(1)
  .max(400)
  .regex(/^[^-\0][^\0]*$/, 'Invalid path');

export const gitBranchSchema = z.strictObject({
  name: z.string().min(1),
  current: z.boolean(),
});

export const gitFileChangeSchema = z.strictObject({
  path: z.string().min(1),
  /** true when the change is in the index. */
  staged: z.boolean(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked']),
});

export const gitStatusSchema = z.strictObject({
  branch: z.string().nullable(),
  detached: z.boolean(),
  clean: z.boolean(),
  files: z.array(gitFileChangeSchema),
});

export const gitCommitSchema = z.strictObject({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  subject: z.string(),
  author: z.string(),
  date: isoDateTimeSchema,
});

export const gitDiffSchema = z.strictObject({
  text: z.string(),
  /** Large diffs are cut off; the client asks for a narrower path instead. */
  truncated: z.boolean(),
});

export type GitBranch = z.infer<typeof gitBranchSchema>;
export type GitFileChange = z.infer<typeof gitFileChangeSchema>;
export type GitStatus = z.infer<typeof gitStatusSchema>;
export type GitCommit = z.infer<typeof gitCommitSchema>;
export type GitDiff = z.infer<typeof gitDiffSchema>;
