import { z } from 'zod';
import { BOARD_ERROR_CODES } from '../../core/errors.js';
import {
  COMMENT_MAX_LENGTH,
  checkKindSchema,
  checkReportContentSchema,
  checkVerdictSchema,
  fromCheckSchema,
} from '../../core/model/history.js';
import { taskIdSchema, taskSchema } from '../../core/model/task.js';
import { taskWorkflowSchema, workflowOverridesSchema } from '../../core/model/workflow.js';

/**
 * Wire DTOs. Where the wire format equals the domain, the core schema is re-exported:
 * duplicating it would only create drift. A v2 contract may diverge; v1 does not.
 */
export {
  aiRunReportSchema,
  aiRunSchema,
  checkReportContentSchema,
  checkReportSchema,
  checkSchema,
  checkSummarySchema,
  checkVerdictSchema,
  decisionSchema,
  documentMetaSchema,
  documentNameSchema,
  effectiveWorkflowSchema,
  evidenceSchema,
  findingSchema,
  fromCheckSchema,
  gitBranchSchema,
  gitCommitSchema,
  gitDiffSchema,
  gitPathSchema,
  gitRefSchema,
  gitStatusSchema,
  projectSchema,
  recommendationEditSchema,
  recommendationSchema,
  reportIdSchema,
  reportSchema,
  taskContentSchema,
  taskIdSchema,
  taskSchema,
  taskVersionSchema,
  taskWorkflowSchema,
  versionListSchema,
  versionSummarySchema,
  workflowFlagsSchema,
  workflowOverridesSchema,
  workflowStateSchema,
} from '../../core/model/index.js';
export {
  CHECK_VERDICTS,
  CONTENT_FIELDS,
  DECISIONS,
  EVIDENCE_KINDS,
  RECOMMENDATION_BASES,
  VERSION_SOURCES,
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
  Check,
  CheckBegin,
  CheckEnd,
  CheckReport,
  CheckReportContent,
  CheckState,
  CheckSummary,
  CheckVerdict,
  ContentField,
  Decision,
  DocumentMeta,
  EffectiveWorkflow,
  GitBranch,
  GitCommit,
  GitDiff,
  GitFileChange,
  GitStatus,
  Evidence,
  Finding,
  FromCheck,
  Project,
  Recommendation,
  RecommendationEdit,
  RepoState,
  Report,
  Task,
  TaskContent,
  TaskVersion,
  VersionList,
  VersionSource,
  VersionSummary,
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
/** `contentHash` of ADR-0030 §1: 64 bits as 16 hex digits. */
export const contentHashSchema = z.string().regex(/^[0-9a-f]{16}$/, 'Must be a content hash');
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
    /**
     * null clears a legacy run without a runId (user cleanup); a run with a runId is refused,
     * 409 AI_RUN_NOT_CLEARABLE (T45). An object is rejected — use the report route (T32).
     */
    aiRun: z.null().optional(),
    /**
     * The `contentHash` of the content this change is based on. When the content is another one,
     * the answer is `409 TASK_CONTENT_CHANGED` and nothing is written; without it the change is
     * last-write-wins, as it always was (ADR-0030 §4).
     */
    ifContentHash: contentHashSchema.optional(),
    /** Where the new content came from, recorded on the version it makes (ADR-0030 §7). */
    fromCheck: fromCheckSchema.optional(),
  })
  .refine(
    (patch) => Object.keys(patch).some((key) => key !== 'ifContentHash' && key !== 'fromCheck'),
    'The patch must change something',
  );

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
export const runTaskRequestSchema = z
  .strictObject({
    agent: agentSchema,
    model: claudeModelSchema.optional(),
    /**
     * `work` (also when absent) is the run of the task; `check` is an actuality check, recorded
     * apart from the run (ADR-0030 §6). A check is always a new session: no `mode`, or `new`.
     */
    kind: z.enum(['work', 'check']).optional(),
    /**
     * `new` (also when absent) starts a session; `resume` continues the session of the last run
     * of the task (T36); `restart` starts the work of the last run over in a new session (T37).
     * A session itself is never sent: the runner reads it from the board, or makes a new one.
     */
    mode: z.enum(['new', 'resume', 'restart']).optional(),
  })
  .refine(
    (request) => request.kind !== 'check' || request.mode === undefined || request.mode === 'new',
    'A check is always a new session: it takes no mode but "new".',
  );

/** The request was handed to a runner; the session is its business from here on. */
export const runStartedSchema = z.strictObject({
  taskId: taskIdSchema,
  agent: agentSchema,
  model: claudeModelSchema.optional(),
  /** The board answers with it only for `resume` and `restart`: a new run needs no word (T36). */
  mode: z.enum(['new', 'resume', 'restart']).optional(),
  /** Only for a check; a run of the task says nothing, as it always did (ADR-0030 §6). */
  kind: z.literal('check').optional(),
});

/** What a waiting runner receives on `GET /runs`, and nothing else ever. */
export const runRequestSchema = z.strictObject({
  type: z.literal('run.requested'),
  taskId: taskIdSchema,
  agent: agentSchema,
  model: claudeModelSchema.optional(),
  mode: z.enum(['resume', 'restart']).optional(),
  kind: z.literal('check').optional(),
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
  /**
   * When the process ended, by the runner's clock; sent when the end is delivered later than it
   * happened, from the runner's journal (T45). Absent means now.
   */
  endedAt: z.iso.datetime({ offset: true }).optional(),
  /**
   * The session of the run that ended (T45). The runner always sends it, and the board then
   * refuses an end of any other run; it is optional only for a runner of an earlier version.
   */
  sessionId: z.string().uuid().optional(),
});

/**
 * `claude --recover` → abandon: the run with this runId and this session is lost (T45). The
 * message is the evidence, or the person's confirmation; it is what `failure.message` keeps.
 */
export const aiRunAbandonRequestSchema = z.strictObject({
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(2000),
});

/** Restore: the content the person saw is required, because a restore replaces all of it. */
export const restoreVersionRequestSchema = z.strictObject({ ifContentHash: contentHashSchema });

export const restoreVersionResponseSchema = z.strictObject({
  task: taskSchema,
  /** False when the task already held the content of that version: nothing was written. */
  changed: z.boolean(),
});

/** Runner → begin a check (not given to agents): who and which session (ADR-0030 §6). */
export const checkBeginRequestSchema = z
  .strictObject({
    agent: z.string().regex(/\S/, 'Must not be blank').max(100),
    sessionId: z.uuid(),
    model: z.string().min(1).max(200).optional(),
    /** Absent is an actuality check (ADR-0030 R1). */
    kind: checkKindSchema.optional(),
    /** The focus of a research, as sent: at most 4 000 characters, no NUL (R2, D12). */
    comment: z
      .string()
      .min(1)
      .max(COMMENT_MAX_LENGTH)
      .refine((text) => !text.includes('\0'), 'Must not contain NUL')
      .optional(),
  })
  .refine((request) => request.comment === undefined || request.kind !== undefined, {
    message: 'A comment belongs to a research: send kind "research" with it.',
    path: ['comment'],
  });

export const checkBeginResponseSchema = z.strictObject({
  number: z.int().min(1),
  /** The version the check is pinned to. */
  version: z.int().min(1),
});

/**
 * Agent → the report of a check, as the agent makes it; stored and shown as sent. An actuality
 * check's has a `verdict`, a research's has its `markdown` (ADR-0030 R1, R3). The request takes
 * either, because which one is right is for the check the report is sent to: the wrong one is
 * `422 INVALID_CHECK_REPORT`, not a malformed request.
 */
export const checkReportRequestSchema = checkReportContentSchema.extend({
  verdict: checkVerdictSchema.optional(),
  markdown: z.string().optional(),
});

/** Runner → the end of a check's process. */
export const checkEndRequestSchema = z.strictObject({
  sessionId: z.uuid(),
  exitCode: z.int().optional(),
  endedAt: z.iso.datetime({ offset: true }).optional(),
});

/** The person's decision on one recommendation of a report. */
export const decisionRequestSchema = z.strictObject({
  recommendation: z.string().min(1).max(40),
  decision: z.enum(['accepted', 'rejected']),
  note: z.string().regex(/\S/, 'Must not be blank').max(2000).optional(),
});

export type RestoreVersionRequest = z.infer<typeof restoreVersionRequestSchema>;
export type RestoreVersionResponse = z.infer<typeof restoreVersionResponseSchema>;
export type CheckBeginRequest = z.infer<typeof checkBeginRequestSchema>;
export type CheckBeginResponse = z.infer<typeof checkBeginResponseSchema>;
export type CheckEndRequest = z.infer<typeof checkEndRequestSchema>;
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;

export type AiRunBeginRequest = z.infer<typeof aiRunBeginRequestSchema>;
export type AiRunEndRequest = z.infer<typeof aiRunEndRequestSchema>;
export type AiRunAbandonRequest = z.infer<typeof aiRunAbandonRequestSchema>;

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
