import { z } from 'zod';
import { documentNameSchema } from './document.js';
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

/** The most paths `changes.files` keeps (ADR-0030 R3, R6, D12); the hash covers them all. */
export const REPO_CHANGES_MAX_FILES = 200;

/**
 * What the working tree held besides HEAD: the paths, and a hash of the status and of the diffs,
 * so that a tree dirty at begin and dirty at the end can still be told apart (ADR-0030 R6).
 */
export const repoChangesSchema = z.strictObject({
  files: z.array(z.string().min(1)).max(REPO_CHANGES_MAX_FILES),
  diffHash: z.string().regex(/^[0-9a-f]{16}$/),
});
export type RepoChanges = z.infer<typeof repoChangesSchema>;

/** Where the repository stood: read-only, and absent without git. */
export const repoStateSchema = z
  .strictObject({
    branch: z.string().min(1).nullable(),
    head: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/)
      .nullable(),
    clean: z.boolean(),
    /** Absent for a clean tree, and in every record written before T59. */
    changes: repoChangesSchema.optional(),
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

/**
 * Why a path is not one in the project, or undefined when it is: relative to the root, no `..`,
 * no NUL. It is not looked up. Shared by the evidence of kind `file` and by the targets of a
 * recommendation, so the two are checked alike (ADR-0030 R4).
 */
export function projectPathProblem(ref: string): string | undefined {
  return ref.startsWith('/') || ref.includes('\0') || ref.split(/[\\/]/).includes('..')
    ? `"${ref}" is not a path inside the project.`
    : undefined;
}

/** What a recommendation is about: a description, never an edit (ADR-0030 R4). */
export const recommendationTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('task') }),
  z.strictObject({ kind: z.literal('document'), name: documentNameSchema }),
  z.strictObject({
    kind: z.literal('file'),
    ref: nonBlank
      .max(500)
      .refine((ref) => projectPathProblem(ref) === undefined, 'Must be a path inside the project'),
  }),
]);
export type RecommendationTarget = z.infer<typeof recommendationTargetSchema>;

export const recommendationSchema = z.strictObject({
  id: idSchema,
  findings: z.array(idSchema).max(50),
  text: nonBlank.max(10_000),
  edit: recommendationEditSchema.optional(),
  targets: z.array(recommendationTargetSchema).max(50).optional(),
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

/** The most characters the markdown of a research report may have (ADR-0030 R3, D12). */
export const RESEARCH_MARKDOWN_MAX_LENGTH = 200_000;

/**
 * What the agent sends for a research: no verdict and no readiness, but the narrative as
 * markdown (ADR-0030 R1, R3). The text is stored in a file of its own, not in the record.
 */
export const researchReportContentSchema = z.strictObject({
  agent: nonBlank.max(100),
  summary: nonBlank.max(10_000),
  uncertainty: nonBlank.max(10_000).optional(),
  findings: z.array(findingSchema).max(200),
  recommendations: z.array(recommendationSchema).max(200),
  markdown: nonBlank.max(RESEARCH_MARKDOWN_MAX_LENGTH),
});
export type ResearchReportContent = z.infer<typeof researchReportContentSchema>;

/** The kinds of check besides the actuality check, which has no `kind` (ADR-0030 R1). */
export const CHECK_KINDS = ['research'] as const;
export const checkKindSchema = z.enum(CHECK_KINDS);
export type CheckKind = z.infer<typeof checkKindSchema>;

export const COMMENT_MAX_LENGTH = 4000;

/** A document as the research saw it: name, size and time, never the text. */
export const begunDocumentSchema = z.strictObject({
  name: documentNameSchema,
  size: z.int().min(0),
  updatedAt: isoDateTimeSchema,
});
export type BegunDocument = z.infer<typeof begunDocumentSchema>;

export const checkBeginSchema = z
  .strictObject({
    taskId: taskIdSchema,
    number: numberSchema,
    /** The version whose snapshot the check reads. */
    version: numberSchema,
    createdAt: isoDateTimeSchema,
    agent: nonBlank.max(100),
    sessionId: z.uuid(),
    model: z.string().min(1).max(200).optional(),
    repo: repoStateSchema,
    /** Absent for an actuality check, so every file written before research reads as one. */
    kind: checkKindSchema.optional(),
    /** The focus the person gave, as sent; a field of this record only (ADR-0030 R2). */
    comment: z
      .string()
      .min(1)
      .max(COMMENT_MAX_LENGTH)
      .refine((text) => !text.includes('\0'), 'Must not contain NUL')
      .optional(),
    documents: z.array(begunDocumentSchema).optional(),
  })
  .refine(
    (begin) =>
      begin.kind !== undefined || (begin.comment === undefined && begin.documents === undefined),
    { message: 'A comment and documents belong to a research only', path: ['kind'] },
  );
export type CheckBegin = z.infer<typeof checkBeginSchema>;

/** The markdown file of a research report, described by the record written after it. */
export const reportMarkdownSchema = z.strictObject({
  bytes: z.int().min(0),
  hash: z.string().regex(/^[0-9a-f]{16}$/),
});
export type ReportMarkdown = z.infer<typeof reportMarkdownSchema>;

/**
 * A report as stored: an actuality check's has a `verdict`, a research's has the description of
 * its `markdown` and no verdict. Exactly one of the two (ADR-0030 R1, R3).
 */
export const checkReportSchema = z
  .strictObject({
    taskId: taskIdSchema,
    check: numberSchema,
    version: numberSchema,
    createdAt: isoDateTimeSchema,
    repo: repoStateSchema,
    agent: nonBlank.max(100),
    verdict: checkVerdictSchema.optional(),
    summary: nonBlank.max(10_000),
    uncertainty: nonBlank.max(10_000).optional(),
    findings: z.array(findingSchema).max(200),
    recommendations: z.array(recommendationSchema).max(200),
    markdown: reportMarkdownSchema.optional(),
  })
  .refine((report) => (report.verdict === undefined) !== (report.markdown === undefined), {
    message: 'A report has a verdict (actuality check) or a markdown (research), not both',
    path: ['verdict'],
  });
export type CheckReport = z.infer<typeof checkReportSchema>;

export const checkEndSchema = z.strictObject({
  taskId: taskIdSchema,
  check: numberSchema,
  sessionId: z.uuid(),
  exitCode: z.int().optional(),
  endedAt: isoDateTimeSchema,
  /** Where the repository stood at the end (ADR-0030 R6); absent in an end written before. */
  repo: repoStateSchema.optional(),
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

/** How the recommendations of a report stand, by their latest decision. */
export const decisionCountsSchema = z.strictObject({
  accepted: z.int().min(0),
  rejected: z.int().min(0),
  undecided: z.int().min(0),
});
export type DecisionCounts = z.infer<typeof decisionCountsSchema>;

export const checkSummarySchema = z.strictObject({
  taskId: taskIdSchema,
  number: numberSchema,
  state: z.enum(CHECK_STATES),
  version: numberSchema,
  createdAt: isoDateTimeSchema,
  agent: nonBlank.max(100),
  kind: checkKindSchema.optional(),
  /** The first line of the comment of a research, cut short; the whole is in the begin. */
  comment: z.string().min(1).optional(),
  verdict: checkVerdictSchema.optional(),
  /** Present once the check has a report. */
  decisions: decisionCountsSchema.optional(),
  endedAt: isoDateTimeSchema.optional(),
});
export type CheckSummary = z.infer<typeof checkSummarySchema>;
