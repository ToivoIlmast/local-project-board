import { z } from 'zod';
import { BOARD_ERROR_CODES } from '../../core/errors.js';
import { taskIdSchema, taskSchema } from '../../core/model/task.js';
import { taskWorkflowSchema, workflowOverridesSchema } from '../../core/model/workflow.js';

/**
 * Wire DTOs. Where the wire format equals the domain, the core schema is re-exported:
 * duplicating it would only create drift. A v2 contract may diverge; v1 does not.
 */
export {
  aiRunReportSchema,
  aiRunSchema,
  documentMetaSchema,
  documentNameSchema,
  effectiveWorkflowSchema,
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
  taskWorkflowSchema,
  workflowFlagsSchema,
  workflowOverridesSchema,
  workflowStateSchema,
} from '../../core/model/index.js';
export {
  BOARD_ONLY_WORKFLOW_KEYS,
  BOARD_WORKFLOW_KEYS,
  SUPPORTED_LANGUAGES,
  TASK_WORKFLOW_KEYS,
  languageName,
  WORKFLOW_FLAGS,
  WORKFLOW_KEYS,
} from '../../core/model/index.js';
export { boardEventSchema } from '../../core/events.js';

/**
 * The wire types themselves, so a client of the API — the board's own page included —
 * never has to reach into the domain model for the shape of an answer (§20).
 */
export type {
  AiRun,
  DocumentMeta,
  EffectiveWorkflow,
  GitBranch,
  GitCommit,
  GitDiff,
  GitFileChange,
  GitStatus,
  Project,
  Report,
  Task,
  BoardOnlyWorkflowKey,
  BoardWorkflowKey,
  BoardWorkflowOverrides,
  SupportedLanguage,
  TaskWorkflowOverrides,
  WorkflowFlag,
  WorkflowKey,
  WorkflowFlagOverrides,
  WorkflowOverrides,
  WorkflowSettings,
  WorkflowSource,
  WorkflowState,
} from '../../core/model/index.js';
export type { BoardEvent } from '../../core/events.js';

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
  /** The task's own overrides of the AI workflow settings; only what is set (ADR-0028). */
  workflow: taskWorkflowSchema.optional(),
});

export const updateTaskRequestSchema = z
  .strictObject({
    title: title.optional(),
    status: z.string().min(1).optional(),
    body: z.string().optional(),
    labels: labels.optional(),
    /** null clears the branch. */
    branch: z.string().min(1).nullable().optional(),
    /** An object replaces the task's overrides whole, as `labels` does; null removes them all. */
    workflow: taskWorkflowSchema.nullable().optional(),
    /** null clears the run (user cleanup). An object is rejected — use the report route (T32). */
    aiRun: z.null().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'The patch must change something');

/** Neighbours are ids in the target column; the server computes the rank (ADR-0011). */
export const moveTaskRequestSchema = z.strictObject({
  status: z.string().min(1),
  after: taskSchema.shape.id.optional(),
  before: taskSchema.shape.id.optional(),
});

/**
 * The overrides of the board and of its columns, both sections required: a request that leaves
 * one out would otherwise wipe it without saying so. Never the state that GET answers with —
 * its `defaults` are not accepted back — and never the effective settings of a task.
 */
export const replaceWorkflowRequestSchema = workflowOverridesSchema;

export const writeDocumentRequestSchema = z.strictObject({ content });

export const createReportRequestSchema = z.strictObject({
  title,
  format: z.enum(['html', 'md']),
  content,
});

export const deletedSchema = z.strictObject({ deleted: z.literal(true) });

/**
 * The agent that Send to AI can start. One, so far: a registry waits for a second real agent
 * (ADR-0029). What is sent is its name; which program that is, the runner alone decides.
 */
const agentSchema = z.literal('claude-code');

/**
 * The model of a run (T35): the one value of a request that reaches the argv of `claude`, so
 * only a closed form passes — a short alias, or a full `claude-…` name. It cannot start with a
 * dash, hold a space or a `;`, or be long. The board keeps no list of full names: they come and
 * go with Claude Code, and `claude` itself refuses one it does not know.
 */
export const CLAUDE_MODEL_ALIASES = ['opus', 'sonnet', 'fable', 'haiku'] as const;
export const claudeModelSchema = z.union([
  z.enum(CLAUDE_MODEL_ALIASES),
  z
    .string()
    .max(64)
    .regex(/^claude-[a-z0-9.-]+(\[1m\])?$/),
]);

/**
 * "Start this agent on this task": a name, and at most a model of the closed form above; never
 * a program, an argument or a prompt (T27). No model means the settings of Claude Code.
 */
export const runTaskRequestSchema = z.strictObject({
  agent: agentSchema,
  model: claudeModelSchema.optional(),
});

/** The request was handed to a runner; the session is its business from here on. */
export const runStartedSchema = z.strictObject({
  taskId: taskIdSchema,
  agent: agentSchema,
  model: claudeModelSchema.optional(),
});

/** What a waiting runner receives on `GET /runs`, and nothing else ever. */
export const runRequestSchema = z.strictObject({
  type: z.literal('run.requested'),
  taskId: taskIdSchema,
  agent: agentSchema,
  model: claudeModelSchema.optional(),
});

/**
 * What the board tells its own page about this run. The token is the whole of it: the page
 * must not learn anything about the machine it runs on, and the token must never be put in
 * the HTML instead (ADR-0008, owner's decision of 2026-09-23).
 */
export const sessionSchema = z.strictObject({ token: z.string().min(1) });

/**
 * Codes the transport itself produces. The domain codes come from the core, so the wire
 * format has one list of error codes and no copy of it can drift (§13).
 */
export const TRANSPORT_ERROR_CODES = [
  'INVALID_REQUEST',
  'INVALID_JSON',
  'UNAUTHORIZED',
  'FORBIDDEN_HOST',
  'FORBIDDEN_ORIGIN',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL_ERROR',
  /** Send to AI found nothing waiting to start the agent (T27). */
  'NO_AGENT_RUNNER',
] as const;

export const errorCodeSchema = z.enum([...BOARD_ERROR_CODES, ...TRANSPORT_ERROR_CODES]);

/** Every failing request answers with this and with nothing else. */
export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string().min(1),
    /** Context for the client; never anything about the machine the board runs on. */
    details: z.record(z.string(), z.unknown()),
  }),
});

/** Runner → begin: identify the session being started (T31). */
export const aiRunBeginRequestSchema = z.strictObject({
  sessionId: z.string().uuid(),
  mode: z.enum(['new', 'resume', 'restart']),
  model: z.string().min(1).max(200).optional(),
});

/** Runner → end: what the process did (T31). */
export const aiRunEndRequestSchema = z.strictObject({
  exitCode: z.number().int().optional(),
  launchError: z.string().min(1).optional(),
});

export type AiRunBeginRequest = z.infer<typeof aiRunBeginRequestSchema>;
export type AiRunEndRequest = z.infer<typeof aiRunEndRequestSchema>;

export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;
export type MoveTaskRequest = z.infer<typeof moveTaskRequestSchema>;
export type ReplaceWorkflowRequest = z.infer<typeof replaceWorkflowRequestSchema>;
export type WriteDocumentRequest = z.infer<typeof writeDocumentRequestSchema>;
export type CreateReportRequest = z.infer<typeof createReportRequestSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type RunTaskRequest = z.infer<typeof runTaskRequestSchema>;
export type RunStarted = z.infer<typeof runStartedSchema>;
export type RunRequest = z.infer<typeof runRequestSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
