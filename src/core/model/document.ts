import { z } from 'zod';
import { isDocumentName } from '../rules/documentName.js';
import { isoDateTimeSchema, taskIdSchema } from './task.js';

export const documentNameSchema = z.string().refine(isDocumentName, 'Invalid document name');

export const documentMetaSchema = z.strictObject({
  taskId: taskIdSchema,
  name: documentNameSchema,
  size: z.int().nonnegative(),
  updatedAt: isoDateTimeSchema,
});

export type DocumentMeta = z.infer<typeof documentMetaSchema>;
