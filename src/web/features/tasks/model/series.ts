import type { CheckSummary, CheckTrigger, ScopeItem, Task } from '../../../../contract/v1/index';

export type ItemState = 'checked' | 'failed' | 'working' | 'unchecked';

/** A series is the completion of a task, the pair (task, `doneAt`): a task done again is a new one. */
export interface Series {
  task: string;
  doneAt: string;
}

export type SeriesRow = ScopeItem & { state: ItemState };

/** The series a task starts by being done; none without `doneAt`. */
export function seriesOf(task: Pick<Task, 'id' | 'doneAt'>): Series | undefined {
  return task.doneAt === undefined ? undefined : { task: task.id, doneAt: task.doneAt };
}

/** The trigger of a check of the series, with the commit the run reported, if it did. */
export function triggerOf(task: Pick<Task, 'id' | 'doneAt' | 'aiRun'>): CheckTrigger | undefined {
  if (task.doneAt === undefined) return undefined;
  const commit = task.aiRun?.commit;
  return {
    reason: 'task-done',
    task: task.id,
    doneAt: task.doneAt,
    ...(commit === undefined ? {} : { commit }),
  };
}

/** The checks of one task that were started by this very completion; no other counts. */
function inSeries(checks: readonly CheckSummary[], series: Series): CheckSummary[] {
  return checks
    .filter(
      (check) => check.trigger?.task === series.task && check.trigger.doneAt === series.doneAt,
    )
    .sort((a, b) => a.number - b.number);
}

/**
 * What a task has had in a series: a report is a check, whatever it recommends, and a late one
 * after a working check makes it checked; otherwise the last check says: failed, or working.
 */
export function itemState(checks: readonly CheckSummary[], series: Series): ItemState {
  const own = inSeries(checks, series);
  if (own.some((check) => check.state === 'reported')) return 'checked';
  const last = own[own.length - 1];
  if (last?.state === 'failed') return 'failed';
  if (own.some((check) => check.state === 'working')) return 'working';
  return 'unchecked';
}

/** The checks of the series still marked as working, oldest first. */
export function workingChecks(checks: readonly CheckSummary[], series: Series): CheckSummary[] {
  return inSeries(checks, series).filter((check) => check.state === 'working');
}

/** Checked of all that are to be checked: a task that is excluded is not in the count. */
export function progress(rows: readonly SeriesRow[]): { checked: number; total: number } {
  const counted = rows.filter((row) => row.excluded === undefined);
  return {
    checked: counted.filter((row) => row.state === 'checked').length,
    total: counted.length,
  };
}

/** The first task to check that is not checked yet; one that is working or failed is one. */
export function nextUnchecked(rows: readonly SeriesRow[]): SeriesRow | undefined {
  return rows.find((row) => row.excluded === undefined && row.state !== 'checked');
}
