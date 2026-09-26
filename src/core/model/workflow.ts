import { z } from 'zod';

/**
 * The AI workflow settings (ADR-0028). The board stores only overrides; the settings a task
 * really runs with are computed by `resolveWorkflow` and never stored.
 *
 * Six settings can be overridden on every level (board, column, task); all of them are booleans.
 */
export const WORKFLOW_FLAGS = ['editCode', 'branch', 'checks', 'commit', 'push', 'report'] as const;

/** Settings that only make sense for the whole board: a column or a task cannot override them. */
export const BOARD_WORKFLOW_KEYS = [
  'startStatus',
  'finishStatus',
  'baseBranch',
  'checkCommand',
] as const;

export const WORKFLOW_KEYS = [...WORKFLOW_FLAGS, ...BOARD_WORKFLOW_KEYS] as const;

export type WorkflowFlag = (typeof WORKFLOW_FLAGS)[number];
export type BoardWorkflowKey = (typeof BOARD_WORKFLOW_KEYS)[number];
export type WorkflowKey = (typeof WORKFLOW_KEYS)[number];

/** Overrides of a column or a task: any subset of the boolean settings. */
export const workflowFlagsSchema = z.strictObject({
  /** The agent changes the project's code; otherwise it only analyses and writes documents. */
  editCode: z.boolean().optional(),
  /** Work in a separate branch `task/<ID>-<slug>` and record it in `task.branch`. */
  branch: z.boolean().optional(),
  /** Run the project's checks before finishing. */
  checks: z.boolean().optional(),
  /** Commit in the task's branch. */
  commit: z.boolean().optional(),
  /** Push the branch. */
  push: z.boolean().optional(),
  /** Leave the result in the task's `report.md`. */
  report: z.boolean().optional(),
});

const nonBlank = z.string().regex(/\S/, 'Must not be blank');

/**
 * Overrides of the whole board. `null` is a value, not a gap: it says "no status change" or
 * "the project's own default", which is different from not setting the key.
 */
export const boardWorkflowSchema = workflowFlagsSchema.extend({
  /** Status a task moves to when work starts. */
  startStatus: z.string().min(1).nullable().optional(),
  /** Status a task moves to when work is finished; `null` leaves it waiting for review. */
  finishStatus: z.string().min(1).nullable().optional(),
  /** The branch work is based on; `null` is the repository's main branch. */
  baseBranch: nonBlank.nullable().optional(),
  /** The command that runs the checks; `null` is the project's full pipeline. */
  checkCommand: nonBlank.nullable().optional(),
});

/**
 * Everything the board stores about the workflow besides the tasks' own overrides.
 * The column keys are statuses; whether they are configured is checked by `findWorkflowIssues`,
 * because the list of statuses lives in the configuration, not here.
 */
export const workflowOverridesSchema = z.strictObject({
  board: boardWorkflowSchema,
  statuses: z.record(z.string().min(1), workflowFlagsSchema),
});

export type WorkflowFlagOverrides = z.infer<typeof workflowFlagsSchema>;
export type BoardWorkflowOverrides = z.infer<typeof boardWorkflowSchema>;
export type WorkflowOverrides = z.infer<typeof workflowOverridesSchema>;

/** The settings a task runs with: every key has a value. */
export const workflowSettingsSchema = z.strictObject({
  editCode: z.boolean(),
  branch: z.boolean(),
  checks: z.boolean(),
  commit: z.boolean(),
  push: z.boolean(),
  report: z.boolean(),
  startStatus: z.string().min(1).nullable(),
  finishStatus: z.string().min(1).nullable(),
  baseBranch: nonBlank.nullable(),
  checkCommand: nonBlank.nullable(),
});

/** Where the value of a setting comes from. */
export const workflowSourceSchema = z.enum(['default', 'board', 'status', 'task']);

/** What `resolveWorkflow` returns; computed on every call and never stored (ADR-0028). */
export const effectiveWorkflowSchema = z.strictObject({
  values: workflowSettingsSchema,
  sources: z.record(z.enum(WORKFLOW_KEYS), workflowSourceSchema),
  /**
   * Settings that have no effect because the agent may not edit code. Their values are left as
   * they are, so switching `editCode` back on restores exactly what was configured.
   */
  inactive: z.array(z.enum(WORKFLOW_FLAGS)),
});

/**
 * What the workflow routes answer for the board: the overrides that are stored, next to the
 * defaults they are laid over. The defaults are read-only context; they are never accepted back
 * (the request of `PUT /workflow` is `workflowOverridesSchema`, which does not know the key).
 */
export const workflowStateSchema = workflowOverridesSchema.extend({
  defaults: workflowSettingsSchema,
});

export type WorkflowSettings = z.infer<typeof workflowSettingsSchema>;
export type WorkflowSource = z.infer<typeof workflowSourceSchema>;
export type EffectiveWorkflow = z.infer<typeof effectiveWorkflowSchema>;
export type WorkflowState = z.infer<typeof workflowStateSchema>;
