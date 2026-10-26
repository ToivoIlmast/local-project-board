import {
  contentHash,
  contentOf,
  isSuperseded,
  latestDecisions,
  recommendationAxes,
  type Check,
  type CheckBegin,
  type CheckKind,
  type CheckSummary,
  type Decision,
  type DecisionCounts,
  type DocumentMeta,
  type Recommendation,
  type RecommendationAxes,
  type RepoState,
  type Task,
  type TaskContent,
  type VersionList,
  type VersionSummary,
} from '../../../../contract/v1/index';

/**
 * What the page works out about the history of a task, with the functions the server runs
 * itself (ADR-0030 §1, §9): the content, its hash, who is the latest. Pure, so a test needs no
 * page for it.
 */

export const CURRENT = 'current';
export type Selected = typeof CURRENT | number;

export function taskContent(task: Task): TaskContent {
  return contentOf(task);
}

export function currentHash(task: Task): string {
  return contentHash(taskContent(task));
}

export function latestOf(list: VersionList | undefined): VersionSummary | undefined {
  return list?.versions.reduce<VersionSummary | undefined>(
    (latest, version) =>
      latest === undefined || version.number > latest.number ? version : latest,
    undefined,
  );
}

/**
 * The number of the version the task is at now, or null when its content is not that of the
 * latest version ("changed outside history"). Worked out here from the hashes, so it is right
 * as soon as the task is, without waiting for the list to be read again.
 */
export function currentVersion(task: Task, list: VersionList | undefined): number | null {
  const latest = latestOf(list);
  return latest !== undefined && latest.hash === currentHash(task) ? latest.number : null;
}

export interface VersionOption {
  value: string;
  label: string;
}

/**
 * The entries of the version select: the current one first, labelled so, and every other
 * version after it, newest first, labelled historical (ADR-0030, T46).
 */
export function versionOptions(task: Task, list: VersionList | undefined): VersionOption[] {
  const versions = [...(list?.versions ?? [])].sort((a, b) => b.number - a.number);
  const at = currentVersion(task, list);
  const first: VersionOption =
    at !== null
      ? { value: CURRENT, label: `v${at} · Current` }
      : {
          value: CURRENT,
          label: versions.length === 0 ? 'Current' : 'Current (changed outside history)',
        };
  return [
    first,
    ...versions
      .filter((version) => version.number !== at)
      .map((version) => ({
        value: String(version.number),
        label: `v${version.number} · historical`,
      })),
  ];
}

/** A selection that names the version the task is at is the current one. */
export function normalizeSelection(
  selected: Selected,
  task: Task,
  list: VersionList | undefined,
): Selected {
  return selected !== CURRENT && selected === currentVersion(task, list) ? CURRENT : selected;
}

export const SOURCE_LABELS = {
  create: 'created',
  baseline: 'first seen',
  external: 'changed outside the board',
  edit: 'edited',
  restore: 'restored',
} as const;

export function versionSummaryText(version: VersionSummary): string {
  const parts: string[] = [SOURCE_LABELS[version.source]];
  if (version.restoredFrom !== undefined) parts.push(`from v${version.restoredFrom}`);
  if (version.changed.length > 0) parts.push(`changed: ${version.changed.join(', ')}`);
  if (version.fromCheck !== undefined) {
    parts.push(`from check C${version.fromCheck.check} (${version.fromCheck.basis})`);
  }
  return parts.join(' · ');
}

// --- editing ---------------------------------------------------------------------------------

export interface TaskDraft {
  title: string;
  status: string;
  labels: string[];
  branch?: string | undefined;
  body: string;
}

/** What a person changed, against the task they started from: nothing else is sent. */
export interface DraftChanges {
  content: { title?: string; body?: string; labels?: string[] };
  status?: string;
  /** null clears the branch. */
  branch?: string | null;
}

export function draftChanges(original: Task, draft: TaskDraft): DraftChanges {
  const changes: DraftChanges = { content: {} };
  if (draft.title !== original.title) changes.content.title = draft.title;
  if (draft.body !== original.body) changes.content.body = draft.body;
  if (
    draft.labels.length !== original.labels.length ||
    draft.labels.some((label, index) => label !== original.labels[index])
  ) {
    changes.content.labels = draft.labels;
  }
  if (draft.status !== original.status) changes.status = draft.status;
  if ((draft.branch ?? undefined) !== original.branch) changes.branch = draft.branch ?? null;
  return changes;
}

export function hasChanges(changes: DraftChanges): boolean {
  return (
    Object.keys(changes.content).length > 0 ||
    changes.status !== undefined ||
    changes.branch !== undefined
  );
}

// --- checks ----------------------------------------------------------------------------------

export function checkId(taskId: string, number: number): string {
  return `${taskId}-C${number}`;
}

export const STATE_LABELS = {
  working: 'Working',
  reported: 'Reported',
  failed: 'Failed',
} as const;

export const VERDICT_LABELS = {
  current: 'Current',
  'partly-outdated': 'Partly outdated',
  outdated: 'Outdated',
  'insufficient-data': 'Insufficient data',
} as const;

export interface Staleness {
  /** The version the check read. */
  version: number;
  /** The version the task is at now; null when it was changed outside the history. */
  now: number | null;
  /** False when the history was not read yet: nothing is claimed. */
  known: boolean;
  stale: boolean;
}

/** A report is stale when the task holds other content than the version it read (ADR-0030 §7). */
export function staleness(
  task: Task,
  list: VersionList | undefined,
  check: Pick<CheckSummary, 'version'>,
): Staleness {
  const pinned = list?.versions.find((version) => version.number === check.version);
  if (list === undefined || pinned === undefined) {
    return { version: check.version, now: null, known: false, stale: false };
  }
  return {
    version: check.version,
    now: currentVersion(task, list),
    known: true,
    stale: pinned.hash !== currentHash(task),
  };
}

export function stalenessText(s: Staleness): string | undefined {
  if (!s.stale) return undefined;
  return s.now === null
    ? `This report is for v${s.version}; the task was changed outside the history since.`
    : `This report is for v${s.version}; the task is now v${s.now}.`;
}

export function describeRepo(repo: RepoState): string {
  if (repo === null) return 'no git repository';
  const head = repo.head === null ? 'no commits' : repo.head.slice(0, 7);
  return `${repo.branch ?? 'detached'} @ ${head}, ${repo.clean ? 'clean' : 'uncommitted changes'}`;
}

/** Whether the branch or HEAD moved between the begin and the report; the tree is `treeChange`. */
export function repoChanged(check: Check): boolean {
  if (check.report === undefined) return false;
  const [before, after] = [check.begin.repo, check.report.repo];
  if (before === null || after === null) return before !== after;
  return before.branch !== after.branch || before.head !== after.head;
}

/** How the working tree changed while a check or research ran (ADR-0030 R6). */
export interface TreeChange {
  /** The paths that came or went; the paths dirty now when only their content changed. */
  files: string[];
  dirtyAtStart: boolean;
}

/**
 * The tree at the begin against the latest record of it: the end, or the report before there is
 * an end. Told apart by `clean` and by `changes.diffHash`, so a tree that was dirty before and is
 * dirty after differently is seen too. A fact about the tree, not about who changed it.
 */
export function treeChange(check: Check): TreeChange | undefined {
  const before = check.begin.repo;
  const after = check.end?.repo ?? check.report?.repo;
  if (before === null || after === null || after === undefined) return undefined;
  if (before.clean === after.clean && before.changes?.diffHash === after.changes?.diffHash) {
    return undefined;
  }
  const was = before.changes?.files ?? [];
  const now = after.changes?.files ?? [];
  const moved = [
    ...now.filter((file) => !was.includes(file)),
    ...was.filter((file) => !now.includes(file)),
  ];
  return { files: (moved.length > 0 ? moved : now).sort(), dirtyAtStart: !before.clean };
}

export interface DocumentChange {
  name: string;
  change: 'changed' | 'added' | 'removed';
}

/**
 * The documents of the task now against what the research saw at its begin (ADR-0030 R2): by
 * name, size and time, as the begin holds them; the text is never compared.
 */
export function documentChanges(
  begun: CheckBegin['documents'],
  now: readonly DocumentMeta[] | undefined,
): DocumentChange[] {
  if (begun === undefined || now === undefined) return [];
  const changes: DocumentChange[] = [];
  for (const document of now) {
    const seen = begun.find(({ name }) => name === document.name);
    if (seen === undefined) changes.push({ name: document.name, change: 'added' });
    else if (seen.size !== document.size || seen.updatedAt !== document.updatedAt) {
      changes.push({ name: document.name, change: 'changed' });
    }
  }
  for (const { name } of begun) {
    if (!now.some((document) => document.name === name)) changes.push({ name, change: 'removed' });
  }
  return changes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Whether HEAD is no longer the commit the report was made on; unknown is not moved. */
export function movedOnSince(report: RepoState, head: string | null | undefined): boolean {
  if (report === null || report.head === null || head === undefined || head === null) return false;
  return !head.startsWith(report.head) && !report.head.startsWith(head);
}

export type DecisionState = 'undecided' | 'accepted' | 'rejected';

export function decisionOf(check: Check, recommendation: string): DecisionState {
  return latestDecisions(check.decisions).get(recommendation)?.decision ?? 'undecided';
}

export function decisionHistory(check: Check, recommendation: string): Decision[] {
  return check.decisions.filter((decision) => decision.recommendation === recommendation);
}

export { isSuperseded };

export const KIND_LABELS = { research: 'Research', check: 'Actuality check' } as const;

/** A check without a kind is an actuality check (ADR-0030 R1). */
export function kindLabel(kind: CheckKind | undefined): string {
  return kind === 'research' ? KIND_LABELS.research : KIND_LABELS.check;
}

export function countsText(counts: DecisionCounts | undefined): string | undefined {
  return counts === undefined
    ? undefined
    : `${counts.accepted} accepted · ${counts.rejected} rejected · ${counts.undecided} undecided`;
}

/**
 * The three values of one recommendation, derived from what the board holds (ADR-0030 R5): the
 * latest decision, the versions that name it, and whether its report is stale or superseded.
 */
export function recommendationState(
  task: Task,
  list: VersionList | undefined,
  checks: readonly Pick<CheckSummary, 'number' | 'state'>[],
  check: Check,
  recommendation: Pick<Recommendation, 'id' | 'edit' | 'targets'>,
): RecommendationAxes {
  return recommendationAxes({
    check: check.begin.number,
    decisions: check.decisions,
    recommendation,
    versions: list?.versions ?? [],
    stale: staleness(task, list, { version: check.begin.version }).stale,
    checks,
  });
}

export const AXIS_LABELS = {
  decision: { undecided: 'Undecided', accepted: 'Accepted', rejected: 'Rejected' },
  currency: { current: 'Current', stale: 'Stale', superseded: 'Superseded' },
} as const;

/** Each axis said on its own: none is read from another (ADR-0030 R5). */
export function axisLabels(axes: RecommendationAxes): {
  decision: string;
  application: string;
  currency: string;
} {
  const { application } = axes;
  return {
    decision: AXIS_LABELS.decision[axes.decision],
    application:
      application.state === 'applied'
        ? `Applied in ${application.versions.map((n) => `v${n}`).join(', ')}`
        : application.state === 'not-applied'
          ? 'Not applied'
          : 'Not applicable here',
    currency: AXIS_LABELS.currency[axes.currency],
  };
}

/**
 * What the start of an implementation should know of the research of the task (D11): a research
 * still working, and recommendations no one decided on. A note, never a reason not to start.
 */
export function launchNotice(checks: readonly CheckSummary[] | undefined): string | undefined {
  const research = (checks ?? []).filter((check) => check.kind === 'research');
  const lines = [
    ...research
      .filter((check) => check.state === 'working')
      .map(
        (check) =>
          `${checkId(check.taskId, check.number)} is still researching this task. Starting now does not wait for it.`,
      ),
    ...research
      .filter((check) => (check.decisions?.undecided ?? 0) > 0)
      .map(
        (check) =>
          `${checkId(check.taskId, check.number)} has ${check.decisions?.undecided} undecided recommendation${check.decisions?.undecided === 1 ? '' : 's'}. Starting now does not decide them.`,
      ),
  ];
  return lines.length === 0 ? undefined : lines.join(' ');
}
