import { z } from 'zod';
import { isReportId } from '../rules/ids.js';
import { isoDateTimeSchema } from './task.js';

export const reportIdSchema = z.string().refine(isReportId, 'Invalid report id');

export const reportSchema = z.strictObject({
  id: reportIdSchema,
  title: z.string().regex(/\S/, 'Must not be blank'),
  format: z.enum(['html', 'md']),
  createdAt: isoDateTimeSchema,
});

export type Report = z.infer<typeof reportSchema>;
