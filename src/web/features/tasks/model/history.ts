import {
  contentHash,
  contentOf,
  latestDecisions,
  type Check,
  type CheckSummary,
  type Decision,
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

export function repoChanged(check: Check): boolean {
  return (
    check.report !== undefined &&
    JSON.stringify(check.begin.repo) !== JSON.stringify(check.report.repo)
  );
}

export type DecisionState = 'undecided' | 'accepted' | 'rejected';

export function decisionOf(check: Check, recommendation: string): DecisionState {
  return latestDecisions(check.decisions).get(recommendation)?.decision ?? 'undecided';
}

export function decisionHistory(check: Check, recommendation: string): Decision[] {
  return check.decisions.filter((decision) => decision.recommendation === recommendation);
}

/** The versions made from a recommendation: derived from `fromCheck`, never stored twice. */
export function appliedIn(
  list: VersionList | undefined,
  check: number,
  recommendation: string,
): number[] {
  return (list?.versions ?? [])
    .filter(
      (version) =>
        version.fromCheck?.check === check &&
        version.fromCheck.recommendations.includes(recommendation),
    )
    .map((version) => version.number);
}
