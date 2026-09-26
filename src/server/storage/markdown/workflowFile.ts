import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import {
  boardWorkflowSchema,
  workflowFlagsSchema,
  type WorkflowOverrides,
} from '../../../core/model/index.js';

/**
 * The layout of `.board/workflow.yaml` (ADR-0028). Both sections are optional in the file so
 * that a person writes only what they mean; `formatVersion` is required so that a file from
 * a newer board is reported instead of being read as if it were this one.
 */
const fileSchema = z.strictObject({
  formatVersion: z.literal(1),
  board: boardWorkflowSchema.optional(),
  statuses: z.record(z.string().min(1), workflowFlagsSchema).optional(),
});

export function serializeWorkflow(workflow: WorkflowOverrides): string {
  const document = {
    formatVersion: 1,
    ...(Object.keys(workflow.board).length > 0 ? { board: workflow.board } : {}),
    ...(Object.keys(workflow.statuses).length > 0 ? { statuses: workflow.statuses } : {}),
  };
  return stringifyYaml(document, { lineWidth: 0 });
}

/** Returns the overrides, or a reason why the file cannot be used (never throws). */
export function parseWorkflow(text: string): { workflow: WorkflowOverrides } | { error: string } {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    return { error: `Invalid YAML: ${(error as Error).message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'The file must be a mapping that starts with `formatVersion: 1`.' };
  }

  const result = fileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') ?? '';
    // An unknown key is reported on its parent, so name the key itself.
    const key = issue?.code === 'unrecognized_keys' ? issue.keys.join(', ') : undefined;
    const where = [path, key].filter((part) => part !== undefined && part !== '').join('.');
    return { error: `${where || 'workflow'}: ${issue?.message ?? 'invalid'}` };
  }
  return {
    workflow: { board: result.data.board ?? {}, statuses: result.data.statuses ?? {} },
  };
}
