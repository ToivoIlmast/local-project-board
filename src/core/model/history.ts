import { z } from 'zod';
import { isoDateTimeSchema, taskIdSchema } from './task.js';

/**
 * The history of a task (ADR-0030): versions of its content and actuality checks. Every record
 * here is written once and never changed; a state such as "working" is derived, not stored.
 */

const nonBlank = z.string().regex(/\S/, 'Must not be blank');

/** What a version holds, and all that it holds: the content of a task, not its place. */
export const taskContentSchema = z.strictObject({
  title: nonBlank,
  body: z.string(),
  labels: z.array(z.string().min(1)),
});
export type TaskContent = z.infer<typeof taskContentSchema>;

export const CONTENT_FIELDS = ['title', 'body', 'labels'] as const;
export type ContentField = (typeof CONTENT_FIELDS)[number];

export const VERSION_SOURCES = ['create', 'baseline', 'external', 'edit', 'restore'] as const;
export const versionSourceSchema = z.enum(VERSION_SOURCES);
export type VersionSource = z.infer<typeof versionSourceSchema>;

const numberSchema = z.int().min(1);

export const RECOMMENDATION_BASES = ['report', 'manual'] as const;

/** Names the check and the recommendations a saved edit came from (ADR-0030 §7). */
export const fromCheckSchema = z.strictObject({
  check: numberSchema,
  recommendations: z.array(nonBlank).min(1),
  basis: z.enum(RECOMMENDATION_BASES),
});
export type FromCheck = z.infer<typeof fromCheckSchema>;

export const taskVersionSchema = z.strictObject({
  taskId: taskIdSchema,
  number: numberSchema,
  createdAt: isoDateTimeSchema,
  source: versionSourceSchema,
  /** The fields that differ from the previous version; empty for `create` and `baseline`. */
  changed: z.array(z.enum(CONTENT_FIELDS)),
  snapshot: taskContentSchema,
  restoredFrom: numberSchema.optional(),
  fromCheck: fromCheckSchema.optional(),
});
export type TaskVersion = z.infer<typeof taskVersionSchema>;

/** A version without its snapshot, with the hash of the content it holds. */
export const versionSummarySchema = taskVersionSchema
  .omit({ snapshot: true })
  .extend({ hash: z.string().regex(/^[0-9a-f]{16}$/) });
export type VersionSummary = z.infer<typeof versionSummarySchema>;

export const versionListSchema = z.strictObject({
  /** The content the task has now; `version` is null when it is not the latest version's. */
  current: z.strictObject({
    hash: z.string().regex(/^[0-9a-f]{16}$/),
    version: numberSchema.nullable(),
  }),
  versions: z.array(versionSummarySchema),
});
export type VersionList = z.infer<typeof versionListSchema>;

/** Where the repository stood: read-only, and absent without git. */
export const repoStateSchema = z
  .strictObject({
    branch: z.string().min(1).nullable(),
    head: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/)
      .nullable(),
    clean: z.boolean(),
  })
  .nullable();
export type RepoState = z.infer<typeof repoStateSchema>;

export const CHECK_VERDICTS = [
  'current',
  'partly-outdated',
  'outdated',
  'insufficient-data',
] as const;
export const checkVerdictSchema = z.enum(CHECK_VERDICTS);
export type CheckVerdict = z.infer<typeof checkVerdictSchema>;

export const EVIDENCE_KINDS = ['file', 'commit', 'task'] as const;
export const evidenceSchema = z.strictObject({
  kind: z.enum(EVIDENCE_KINDS),
  ref: nonBlank.max(500),
  note: nonBlank.max(1000).optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, 'Must be a short id');

export const findingSchema = z.strictObject({
  id: idSchema,
  title: nonBlank.max(300),
  explanation: nonBlank.max(10_000),
  evidence: z.array(evidenceSchema).max(50),
});
export type Finding = z.infer<typeof findingSchema>;

/** A change a recommendation proposes; applied only by a person, by the page (ADR-0030 §7). */
export const recommendationEditSchema = z.discriminatedUnion('field', [
  z.strictObject({ field: z.literal('title'), value: z.string() }),
  z.strictObject({
    field: z.literal('labels'),
    add: z.array(z.string().min(1)).max(50),
    remove: z.array(z.string().min(1)).max(50),
  }),
  z.strictObject({
    field: z.literal('body'),
    find: z.string().min(1),
    replace: z.string(),
  }),
]);
export type RecommendationEdit = z.infer<typeof recommendationEditSchema>;

export const recommendationSchema = z.strictObject({
  id: idSchema,
  findings: z.array(idSchema).max(50),
  text: nonBlank.max(10_000),
  edit: recommendationEditSchema.optional(),
});
export type Recommendation = z.infer<typeof recommendationSchema>;

/** What the agent sends; stored and shown as sent (ADR-0030 §2). */
export const checkReportContentSchema = z.strictObject({
  agent: nonBlank.max(100),
  verdict: checkVerdictSchema,
  summary: nonBlank.max(10_000),
  uncertainty: nonBlank.max(10_000).optional(),
  findings: z.array(findingSchema).max(200),
  recommendations: z.array(recommendationSchema).max(200),
});
export type CheckReportContent = z.infer<typeof checkReportContentSchema>;

export const checkBeginSchema = z.strictObject({
  taskId: taskIdSchema,
  number: numberSchema,
  /** The version whose snapshot the check reads. */
  version: numberSchema,
  createdAt: isoDateTimeSchema,
  agent: nonBlank.max(100),
  sessionId: z.uuid(),
  model: z.string().min(1).max(200).optional(),
  repo: repoStateSchema,
});
export type CheckBegin = z.infer<typeof checkBeginSchema>;

export const checkReportSchema = checkReportContentSchema.extend({
  taskId: taskIdSchema,
  check: numberSchema,
  version: numberSchema,
  createdAt: isoDateTimeSchema,
  repo: repoStateSchema,
});
export type CheckReport = z.infer<typeof checkReportSchema>;

export const checkEndSchema = z.strictObject({
  taskId: taskIdSchema,
  check: numberSchema,
  sessionId: z.uuid(),
  exitCode: z.int().optional(),
  endedAt: isoDateTimeSchema,
});
export type CheckEnd = z.infer<typeof checkEndSchema>;

export const DECISIONS = ['accepted', 'rejected'] as const;
export const decisionSchema = z.strictObject({
  taskId: taskIdSchema,
  check: numberSchema,
  /** Which decision of the check this is, 1, 2, …; the latest per recommendation counts. */
  number: numberSchema,
  recommendation: idSchema,
  decision: z.enum(DECISIONS),
  note: nonBlank.max(2000).optional(),
  createdAt: isoDateTimeSchema,
});
export type Decision = z.infer<typeof decisionSchema>;

export const CHECK_STATES = ['working', 'reported', 'failed'] as const;
export type CheckState = (typeof CHECK_STATES)[number];

/** A check as the files hold it, with its state derived from them. */
export const checkSchema = z.strictObject({
  state: z.enum(CHECK_STATES),
  begin: checkBeginSchema,
  report: checkReportSchema.optional(),
  end: checkEndSchema.optional(),
  decisions: z.array(decisionSchema),
});
export type Check = z.infer<typeof checkSchema>;

export const checkSummarySchema = z.strictObject({
  taskId: taskIdSchema,
  number: numberSchema,
  state: z.enum(CHECK_STATES),
  version: numberSchema,
  createdAt: isoDateTimeSchema,
  agent: nonBlank.max(100),
  verdict: checkVerdictSchema.optional(),
  endedAt: isoDateTimeSchema.optional(),
});
export type CheckSummary = z.infer<typeof checkSummarySchema>;
