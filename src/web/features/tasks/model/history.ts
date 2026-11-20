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
import { taskT } from '../i18n/details';

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
      ? { value: CURRENT, label: taskT('versions.currentLabeled', { version: at }) }
      : {
          value: CURRENT,
          label:
            versions.length === 0 ? taskT('versions.current') : taskT('versions.currentOutside'),
        };
  return [
    first,
    ...versions
      .filter((version) => version.number !== at)
      .map((version) => ({
        value: String(version.number),
        label: taskT('versions.historical', { version: version.number }),
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

const SOURCE_KEYS = {
  create: 'source.create',
  baseline: 'source.baseline',
  external: 'source.external',
  edit: 'source.edit',
  restore: 'source.restore',
} as const;

/** A name the page knows is said in the language shown; any other is left as the board sent it. */
function known<K extends string>(
  names: readonly K[],
  value: string,
  say: (name: K) => string,
): string {
  return (names as readonly string[]).includes(value) ? say(value as K) : value;
}

export function versionSummaryText(version: VersionSummary): string {
  const parts: string[] = [taskT(SOURCE_KEYS[version.source])];
  if (version.restoredFrom !== undefined) {
    parts.push(taskT('summary.from', { version: version.restoredFrom }));
  }
  if (version.changed.length > 0) {
    const fields = version.changed.map((field) =>
      known(['title', 'labels', 'body'] as const, field, (name) => taskT(`summary.field.${name}`)),
    );
    parts.push(taskT('summary.changed', { fields: fields.join(', ') }));
  }
  if (version.fromCheck !== undefined) {
    parts.push(
      taskT('summary.fromCheck', {
        check: version.fromCheck.check,
        basis: known(['report', 'manual'] as const, version.fromCheck.basis, (name) =>
          taskT(`summary.basis.${name}`),
        ),
      }),
    );
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

/** The state of a check in the language shown. */
export function stateLabel(state: CheckSummary['state']): string {
  return taskT(`check.state.${state}`);
}

/** The verdict of a check report in the language shown. */
export function verdictLabel(verdict: NonNullable<CheckSummary['verdict']>): string {
  return taskT(`check.verdict.${verdict}`);
}

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
    ? taskT('check.staleOutside', { version: s.version })
    : taskT('check.staleNow', { version: s.version, now: s.now });
}

export function describeRepo(repo: RepoState): string {
  if (repo === null) return taskT('check.repo.none');
  return taskT('check.repo.line', {
    branch: repo.branch ?? taskT('check.repo.detached'),
    head: repo.head === null ? taskT('check.repo.noCommits') : repo.head.slice(0, 7),
    state: repo.clean ? taskT('check.repo.clean') : taskT('check.repo.dirty'),
  });
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

/** A check without a kind is an actuality check (ADR-0030 R1). */
export function kindLabel(kind: CheckKind | undefined): string {
  return kind === 'research' ? taskT('check.kind.research') : taskT('check.kind.check');
}

export function countsText(counts: DecisionCounts | undefined): string | undefined {
  return counts === undefined ? undefined : taskT('check.counts', { ...counts });
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

const CURRENCY_KEYS = {
  current: 'check.verdict.current',
  stale: 'check.stale',
  superseded: 'check.superseded',
} as const;

/** Each axis said on its own: none is read from another (ADR-0030 R5). */
export function axisLabels(axes: RecommendationAxes): {
  decision: string;
  application: string;
  currency: string;
} {
  const { application } = axes;
  return {
    decision: taskT(`check.axis.${axes.decision}`),
    application:
      application.state === 'applied'
        ? taskT('check.applied', { versions: application.versions.map((n) => `v${n}`).join(', ') })
        : application.state === 'not-applied'
          ? taskT('check.notApplied')
          : taskT('check.notApplicable'),
    currency: taskT(CURRENCY_KEYS[axes.currency]),
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
      .map((check) =>
        taskT('ai.launch.researching', { check: checkId(check.taskId, check.number) }),
      ),
    ...research
      .filter((check) => (check.decisions?.undecided ?? 0) > 0)
      .map((check) =>
        taskT('ai.launch.undecided', {
          check: checkId(check.taskId, check.number),
          count: check.decisions?.undecided ?? 0,
        }),
      ),
  ];
  return lines.length === 0 ? undefined : lines.join(' ');
}
