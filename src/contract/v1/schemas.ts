import { z } from 'zod';
import { taskSchema } from '../../core/model/task.js';

/**
 * Wire DTOs. Where the wire format equals the domain, the core schema is re-exported:
 * duplicating it would only create drift. A v2 contract may diverge; v1 does not.
 */
export {
  documentMetaSchema,
  documentNameSchema,
  gitBranchSchema,
  gitCommitSchema,
  gitDiffSchema,
  gitPathSchema,
  gitRefSchema,
  gitStatusSchema,
  projectSchema,
  reportIdSchema,
  reportSchema,
  taskIdSchema,
  taskSchema,
} from '../../core/model/index.js';
export { boardEventSchema } from '../../core/events.js';

const title = z.string().regex(/\S/, 'Must not be blank');
const labels = z.array(z.string().min(1));
/** A document or report body; the board is not a file server. */
const content = z.string().max(1_000_000);

export const createTaskRequestSchema = z.strictObject({
  title,
  /** Defaults to the first configured status. */
  status: z.string().min(1).optional(),
  body: z.string().optional(),
  labels: labels.optional(),
  branch: z.string().min(1).optional(),
});

export const updateTaskRequestSchema = z
  .strictObject({
    title: title.optional(),
    status: z.string().min(1).optional(),
    body: z.string().optional(),
    labels: labels.optional(),
    /** null clears the branch. */
    branch: z.string().min(1).nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'The patch must change something');

/** Neighbours are ids in the target column; the server computes the rank (ADR-0011). */
export const moveTaskRequestSchema = z.strictObject({
  status: z.string().min(1),
  after: taskSchema.shape.id.optional(),
  before: taskSchema.shape.id.optional(),
});

export const writeDocumentRequestSchema = z.strictObject({ content });

export const createReportRequestSchema = z.strictObject({
  title,
  format: z.enum(['html', 'md']),
  content,
});

export const deletedSchema = z.strictObject({ deleted: z.literal(true) });

export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;
export type MoveTaskRequest = z.infer<typeof moveTaskRequestSchema>;
export type WriteDocumentRequest = z.infer<typeof writeDocumentRequestSchema>;
export type CreateReportRequest = z.infer<typeof createReportRequestSchema>;
