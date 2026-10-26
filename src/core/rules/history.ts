import type {
  Check,
  CheckBegin,
  CheckEnd,
  CheckReport,
  CheckReportContent,
  CheckKind,
  CheckState,
  CheckSummary,
  ContentField,
  Decision,
  DecisionCounts,
  Recommendation,
  RepoChanges,
  RepoState,
  ReportMarkdown,
  ResearchReportContent,
  TaskContent,
  TaskVersion,
} from '../model/history.js';
import {
  CONTENT_FIELDS,
  REPO_CHANGES_MAX_FILES,
  RESEARCH_MARKDOWN_MAX_LENGTH,
  checkReportSchema,
  projectPathProblem,
  researchReportContentSchema,
} from '../model/history.js';
import { BoardError } from '../errors.js';
import { isTaskId } from './ids.js';

/** The content of a task, whole or in part: the three fields a version holds (ADR-0030 §1). */
export function contentOf(task: TaskContent): TaskContent {
  return { title: task.title, body: task.body, labels: [...task.labels] };
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * A short name for "the content I saw": FNV-1a, 64 bits, over the canonical JSON of
 * `[title, body, labels]`, as 16 hex digits. Not a security mechanism. The same function runs in
 * the server and in the page, so the page never asks for a hash (ADR-0030 §1).
 */
export function contentHash(content: TaskContent): string {
  return textHash(JSON.stringify([content.title, content.body, content.labels]));
}

/** FNV-1a, 64 bits, over the UTF-16 code units of a text, as 16 hex digits. */
function textHash(text: string): string {
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * What the working tree holds besides HEAD (ADR-0030 R6): its paths, sorted and cut at the limit
 * of D12, and a hash of the whole status and of both diffs, so that a tree dirty before and dirty
 * after is still told apart. Undefined for a clean tree. An untracked file is seen by its path
 * only: git shows no diff of it.
 */
export function repoChanges(
  files: readonly { path: string; staged: boolean; status: string }[],
  diffs: { unstaged: string; staged: string },
): RepoChanges | undefined {
  if (files.length === 0) return undefined;
  // In an order of their own, so the same tree has the same hash whatever git printed first.
  const status = files
    .map(({ path, staged, status }) => `${path}\0${String(staged)}\0${status}`)
    .sort();
  const paths = [...new Set(files.map(({ path }) => path))].sort();
  return {
    files: paths.slice(0, REPO_CHANGES_MAX_FILES),
    diffHash: textHash(JSON.stringify([status, diffs.unstaged, diffs.staged])),
  };
}

/** Exact comparison: a string differs in one character, labels as ordered arrays. */
export function sameContent(a: TaskContent, b: TaskContent): boolean {
  return changedFields(a, b).length === 0;
}

/** The fields of `after` that differ from `before`, in the fixed order of the model. */
export function changedFields(before: TaskContent, after: TaskContent): ContentField[] {
  return CONTENT_FIELDS.filter((field) =>
    field === 'labels'
      ? before.labels.length !== after.labels.length ||
        before.labels.some((label, index) => label !== after.labels[index])
      : before[field] !== after[field],
  );
}

/** The content with the fields of a patch put over it; fields the patch does not carry stay. */
export function applyContentPatch(
  content: TaskContent,
  patch: { title?: string | undefined; body?: string | undefined; labels?: string[] | undefined },
): TaskContent {
  return {
    title: patch.title ?? content.title,
    body: patch.body ?? content.body,
    labels: [...(patch.labels ?? content.labels)],
  };
}

// --- diff ----------------------------------------------------------------------------------

export type DiffKind = 'same' | 'add' | 'remove';

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** Above this many cells the table of the exact diff is not built; the change is shown whole. */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * A line diff of two texts. Lines are split on `\n`; the common head and tail are not compared,
 * so a small edit in a long text stays cheap. Pure, so the page can show a draft against the
 * current content without a request (ADR-0030 §9).
 */
export function diffLines(before: string, after: string): DiffLine[] {
  if (before === after) return before === '' ? [] : split(before).map((text) => same(text));
  const a = before === '' ? [] : split(before);
  const b = after === '' ? [] : split(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);
  return [
    ...a.slice(0, head).map(same),
    ...diffMiddle(middleA, middleB),
    ...a.slice(a.length - tail).map(same),
  ];
}

function split(text: string): string[] {
  return text.split('\n');
}

function same(text: string): DiffLine {
  return { kind: 'same', text };
}

function diffMiddle(a: string[], b: string[]): DiffLine[] {
  if (a.length === 0) return b.map((text) => ({ kind: 'add' as const, text }));
  if (b.length === 0) return a.map((text) => ({ kind: 'remove' as const, text }));
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [
      ...a.map((text) => ({ kind: 'remove' as const, text })),
      ...b.map((text) => ({ kind: 'add' as const, text })),
    ];
  }

  // Longest common subsequence, filled from the end so the walk below goes forward.
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push(same(a[i] as string));
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      lines.push({ kind: 'remove', text: a[i] as string });
      i += 1;
    } else {
      lines.push({ kind: 'add', text: b[j] as string });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) lines.push({ kind: 'remove', text: a[i] as string });
  for (; j < b.length; j += 1) lines.push({ kind: 'add', text: b[j] as string });
  return lines;
}

export interface ContentDiff {
  /** The fields that differ, as `changedFields` says. */
  changed: ContentField[];
  title: { before: string; after: string } | null;
  body: DiffLine[] | null;
  labels: { added: string[]; removed: string[]; reordered: boolean } | null;
}

/** What differs between two contents, field by field; a field that is equal is `null`. */
export function diffContent(before: TaskContent, after: TaskContent): ContentDiff {
  const changed = changedFields(before, after);
  const labelsChanged = changed.includes('labels');
  return {
    changed,
    title: changed.includes('title') ? { before: before.title, after: after.title } : null,
    body: changed.includes('body') ? diffLines(before.body, after.body) : null,
    labels: labelsChanged
      ? {
          added: after.labels.filter((label) => !before.labels.includes(label)),
          removed: before.labels.filter((label) => !after.labels.includes(label)),
          reordered:
            before.labels.length === after.labels.length &&
            before.labels.every((label) => after.labels.includes(label)),
        }
      : null,
  };
}

// --- recommendations -------------------------------------------------------------------------

export type NotApplied = 'advice' | 'not-found' | 'ambiguous' | 'blank-title';

export interface AppliedRecommendations {
  content: TaskContent;
  /** Ids of the recommendations whose edit was applied, in order. */
  applied: string[];
  /** Ids of those that were not, with the reason; they are for the person to look at. */
  notApplied: { id: string; reason: NotApplied }[];
}

/** How many times `find` occurs in `text`, without overlapping. */
export function occurrences(text: string, find: string): number {
  if (find === '') return 0;
  let count = 0;
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + find.length)) {
    count += 1;
  }
  return count;
}

/**
 * Applies the `edit`s of the given recommendations, in order, onto the content (ADR-0030 §7).
 * A body `find` has to occur exactly once in the text as it is after the earlier edits; if it
 * does not, that recommendation is left out and named. A recommendation without an `edit` is
 * advice and is never applied. The caller passes the accepted ones only.
 */
export function applyRecommendations(
  content: TaskContent,
  recommendations: readonly Pick<Recommendation, 'id' | 'edit'>[],
): AppliedRecommendations {
  let draft = contentOf(content);
  const applied: string[] = [];
  const notApplied: AppliedRecommendations['notApplied'] = [];

  for (const { id, edit } of recommendations) {
    if (edit === undefined) {
      notApplied.push({ id, reason: 'advice' });
    } else if (edit.field === 'title') {
      if (!/\S/.test(edit.value)) {
        notApplied.push({ id, reason: 'blank-title' });
      } else {
        draft = { ...draft, title: edit.value };
        applied.push(id);
      }
    } else if (edit.field === 'labels') {
      const labels = draft.labels.filter((label) => !edit.remove.includes(label));
      for (const label of edit.add) if (!labels.includes(label)) labels.push(label);
      draft = { ...draft, labels };
      applied.push(id);
    } else {
      const count = occurrences(draft.body, edit.find);
      if (count === 0) {
        notApplied.push({ id, reason: 'not-found' });
      } else if (count > 1) {
        notApplied.push({ id, reason: 'ambiguous' });
      } else {
        const at = draft.body.indexOf(edit.find);
        draft = {
          ...draft,
          body: draft.body.slice(0, at) + edit.replace + draft.body.slice(at + edit.find.length),
        };
        applied.push(id);
      }
    }
  }
  return { content: draft, applied, notApplied };
}

// --- checks ----------------------------------------------------------------------------------

/** The state follows from which files exist; it is never stored (ADR-0030 §2). */
export function checkState(parts: { report?: unknown; end?: unknown }): CheckState {
  if (parts.report !== undefined) return 'reported';
  return parts.end !== undefined ? 'failed' : 'working';
}

export function assembleCheck(parts: {
  begin: CheckBegin;
  report?: CheckReport | undefined;
  end?: CheckEnd | undefined;
  decisions: Decision[];
}): Check {
  return {
    state: checkState(parts),
    begin: parts.begin,
    ...(parts.report === undefined ? {} : { report: parts.report }),
    ...(parts.end === undefined ? {} : { end: parts.end }),
    decisions: [...parts.decisions].sort((a, b) => a.number - b.number),
  };
}

/** The latest decision per recommendation: the current state of each; earlier ones stay in history. */
export function latestDecisions(decisions: readonly Decision[]): Map<string, Decision> {
  const latest = new Map<string, Decision>();
  for (const decision of [...decisions].sort((a, b) => a.number - b.number)) {
    latest.set(decision.recommendation, decision);
  }
  return latest;
}

/**
 * A report is stale when the task now holds other content than the version it was made on
 * (ADR-0030 §7). A comparison of two hashes, not a flag anyone sets.
 */
export function isReportStale(current: TaskContent, pinned: TaskContent): boolean {
  return !sameContent(current, pinned);
}

const COMMIT_REF = /^[0-9a-f]{7,64}$/;

/** What is wrong with a report against the snapshot it was made on; empty when nothing is. */
export function reportProblems(
  report: Pick<CheckReportContent, 'findings' | 'recommendations'>,
  snapshot: TaskContent,
): string[] {
  const problems: string[] = [];
  const findingIds = new Set<string>();
  for (const finding of report.findings) {
    if (findingIds.has(finding.id)) problems.push(`Finding id "${finding.id}" is used twice.`);
    findingIds.add(finding.id);
    for (const evidence of finding.evidence) {
      const problem = evidenceProblem(evidence.kind, evidence.ref);
      if (problem !== undefined) problems.push(`Finding "${finding.id}": ${problem}`);
    }
  }

  const recommendationIds = new Set<string>();
  for (const recommendation of report.recommendations) {
    const label = `Recommendation "${recommendation.id}"`;
    if (recommendationIds.has(recommendation.id)) problems.push(`${label} is used twice.`);
    recommendationIds.add(recommendation.id);
    for (const finding of recommendation.findings) {
      if (!findingIds.has(finding))
        problems.push(`${label} names an unknown finding "${finding}".`);
    }
    const edit = recommendation.edit;
    if (edit?.field === 'title' && !/\S/.test(edit.value)) {
      problems.push(`${label}: a title edit must not be blank.`);
    } else if (edit?.field === 'body') {
      const count = occurrences(snapshot.body, edit.find);
      if (count !== 1) {
        problems.push(
          `${label}: "find" must occur exactly once in the body of the version that was ` +
            `checked, but it occurs ${count} times.`,
        );
      }
    }
  }
  return problems;
}

/**
 * What a research report's markdown weighs on disk, and a short name for its bytes (FNV-1a over
 * UTF-8, 16 hex digits; not a security mechanism, like `contentHash`). The record written after
 * the file carries both (ADR-0030 R3).
 */
export function reportMarkdownMeta(markdown: string): ReportMarkdown {
  let hash = FNV_OFFSET;
  let bytes = 0;
  const feed = (byte: number): void => {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
    bytes += 1;
  };
  // The core has no TextEncoder; a lone surrogate becomes U+FFFD, as Node writes it to a file.
  for (const char of markdown) {
    let code = char.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) feed(code);
    else if (code < 0x800) {
      feed(0xc0 | (code >> 6));
      feed(0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      feed(0xe0 | (code >> 12));
      feed(0x80 | ((code >> 6) & 0x3f));
      feed(0x80 | (code & 0x3f));
    } else {
      feed(0xf0 | (code >> 18));
      feed(0x80 | ((code >> 12) & 0x3f));
      feed(0x80 | ((code >> 6) & 0x3f));
      feed(0x80 | (code & 0x3f));
    }
  }
  return { bytes, hash: hash.toString(16).padStart(16, '0') };
}

/**
 * The stored record of a report, and for a research the text that goes in a file of its own.
 * One place for both providers: a report must be of the kind its check began as, and must fit
 * the model and its limits, or `INVALID_CHECK_REPORT` and nothing is written.
 */
export function storedCheckReport(
  begin: CheckBegin,
  input: (CheckReportContent | ResearchReportContent) & {
    version: number;
    repo: RepoState;
    createdAt: string;
  },
): { report: CheckReport; markdown?: string } {
  const refuse = (message: string): BoardError =>
    new BoardError('INVALID_CHECK_REPORT', message, { id: begin.taskId, check: begin.number });
  const { markdown, ...rest } = input as typeof input & { markdown?: string };
  const research = begin.kind === 'research';
  if (research && markdown === undefined) throw refuse('A research report needs its markdown.');
  if (research && 'verdict' in rest) throw refuse('A research report has no verdict.');
  if (!research && markdown !== undefined) {
    throw refuse('An actuality check report has no markdown.');
  }
  if (markdown !== undefined) {
    const text = researchReportContentSchema.shape.markdown.safeParse(markdown);
    if (!text.success) throw refuse(`markdown: ${text.error.issues[0]?.message ?? 'invalid'}`);
  }

  const parsed = checkReportSchema.safeParse({
    ...rest,
    taskId: begin.taskId,
    check: begin.number,
    ...(markdown === undefined ? {} : { markdown: reportMarkdownMeta(markdown) }),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw refuse(`${issue?.path.join('.') || 'report'}: ${issue?.message ?? 'invalid'}`);
  }
  return { report: parsed.data, ...(markdown === undefined ? {} : { markdown }) };
}

function evidenceProblem(kind: 'file' | 'commit' | 'task', ref: string): string | undefined {
  if (kind === 'commit') {
    return COMMIT_REF.test(ref) ? undefined : `"${ref}" is not a commit SHA.`;
  }
  if (kind === 'task') {
    return isTaskId(ref) ? undefined : `"${ref}" is not a task id.`;
  }
  // A file is a path in the project, relative to its root; it is not looked up.
  return projectPathProblem(ref);
}

/**
 * What is wrong with a report as a report of the kind its check began as (ADR-0030 R1, R3): an
 * actuality check's has a verdict and no markdown, a research's the opposite. The kind comes
 * from the begin record, never from the report, so an agent cannot choose its own rules.
 */
export function reportKindProblems(
  kind: CheckKind | undefined,
  report: {
    readonly verdict?: unknown;
    readonly markdown?: unknown;
    readonly [key: string]: unknown;
  },
): string[] {
  const problems: string[] = [];
  if (kind === 'research') {
    if (report.verdict !== undefined) problems.push('A research report has no verdict.');
    if (typeof report.markdown !== 'string' || !/\S/.test(report.markdown)) {
      problems.push('A research report needs its markdown.');
    } else if (report.markdown.length > RESEARCH_MARKDOWN_MAX_LENGTH) {
      problems.push(`The markdown is over ${RESEARCH_MARKDOWN_MAX_LENGTH} characters.`);
    }
  } else {
    if (report.verdict === undefined) problems.push('An actuality check report needs a verdict.');
    if (report.markdown !== undefined) problems.push('An actuality check report has no markdown.');
  }
  return problems;
}

const COMMENT_SUMMARY_LENGTH = 120;

/** The first line of a comment, cut to a limit; an ellipsis says that something was left out. */
export function summarizeComment(comment: string): string {
  const text = comment.trim();
  const first = (text.split(/\r?\n/, 1)[0] ?? '').trimEnd();
  const cut = first.length > COMMENT_SUMMARY_LENGTH;
  return `${cut ? first.slice(0, COMMENT_SUMMARY_LENGTH) : first}${cut || first.length < text.length ? '…' : ''}`;
}

/** How the recommendations of a report stand: by their latest decision (ADR-0030 §2). */
export function decisionCounts(check: Check): DecisionCounts | undefined {
  if (check.report === undefined) return undefined;
  const latest = latestDecisions(check.decisions);
  const counts = { accepted: 0, rejected: 0, undecided: 0 };
  for (const { id } of check.report.recommendations)
    counts[latest.get(id)?.decision ?? 'undecided'] += 1;
  return counts;
}

/** A check as the lists show it: its begin, its state, and how its recommendations stand. */
export function summarizeCheck(check: Check): CheckSummary {
  const decisions = decisionCounts(check);
  return {
    taskId: check.begin.taskId,
    number: check.begin.number,
    state: check.state,
    version: check.begin.version,
    createdAt: check.begin.createdAt,
    agent: check.report?.agent ?? check.begin.agent,
    ...(check.begin.kind === undefined ? {} : { kind: check.begin.kind }),
    ...(check.begin.comment === undefined
      ? {}
      : { comment: summarizeComment(check.begin.comment) }),
    ...(check.report?.verdict === undefined ? {} : { verdict: check.report.verdict }),
    ...(decisions === undefined ? {} : { decisions }),
    ...(check.end === undefined ? {} : { endedAt: check.end.endedAt }),
  };
}

/**
 * Whether a later check or research of the task has reported (ADR-0030 R5): a note on the older
 * one, which blocks nothing and changes no data.
 */
export function isSuperseded(
  checks: readonly { number: number; state: CheckState }[],
  check: number,
): boolean {
  return checks.some((c) => c.number > check && c.state === 'reported');
}

export type RecommendationDecision = 'undecided' | Decision['decision'];
export type RecommendationApplication =
  { state: 'applied'; versions: number[] } | { state: 'not-applied' } | { state: 'not-applicable' };
export type RecommendationCurrency = 'current' | 'stale' | 'superseded';

export interface RecommendationAxes {
  decision: RecommendationDecision;
  application: RecommendationApplication;
  currency: RecommendationCurrency;
}

/**
 * The three independent values of a recommendation (ADR-0030 R5). Nothing is stored for them and
 * none follows from another: "accepted" is not "applied" (only a version that names the
 * recommendation is), and "superseded" is a note that blocks nothing.
 */
export function recommendationAxes(input: {
  check: number;
  decisions: readonly Decision[];
  recommendation: Pick<Recommendation, 'id' | 'edit' | 'targets'>;
  versions: readonly Pick<TaskVersion, 'number' | 'fromCheck'>[];
  /** As `isReportStale` says of the check. */
  stale: boolean;
  /** Every check of the task, this one included. */
  checks: readonly { number: number; state: CheckState }[];
}): RecommendationAxes {
  const { check, recommendation } = input;
  const decision = latestDecisions(input.decisions).get(recommendation.id)?.decision;

  const versions = input.versions
    .filter(
      (version) =>
        version.fromCheck?.check === check &&
        version.fromCheck.recommendations.includes(recommendation.id),
    )
    .map((version) => version.number)
    .sort((a, b) => a - b);
  // A button applies an `edit` to the task only; anything else is carried over by hand (R4).
  const aimedAtTask =
    recommendation.edit !== undefined &&
    (recommendation.targets === undefined ||
      recommendation.targets.some((target) => target.kind === 'task'));
  const application: RecommendationApplication =
    versions.length > 0
      ? { state: 'applied', versions }
      : aimedAtTask
        ? { state: 'not-applied' }
        : { state: 'not-applicable' };

  return {
    decision: decision ?? 'undecided',
    application,
    currency: input.stale ? 'stale' : isSuperseded(input.checks, check) ? 'superseded' : 'current',
  };
}

/**
 * What keeps Apply from a report (ADR-0030 R4, D6): the report is stale, or a recommendation's
 * latest decision is not "accepted". Nothing else does: a newer research or a repository that
 * moved on is a note. The server and the page use this one rule.
 */
export function applyBlockers(input: {
  stale: boolean;
  decisions: readonly Decision[];
  recommendations: readonly string[];
}): { blocked: boolean; stale: boolean; notAccepted: string[] } {
  const latest = latestDecisions(input.decisions);
  const notAccepted = input.recommendations.filter((id) => latest.get(id)?.decision !== 'accepted');
  return {
    blocked: input.stale || notAccepted.length > 0,
    stale: input.stale,
    notAccepted,
  };
}
