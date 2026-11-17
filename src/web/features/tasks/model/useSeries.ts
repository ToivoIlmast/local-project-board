import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  launchState,
  revalidationScope,
  type RevalidationInput,
  type Task,
} from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import { itemState, progress, seriesOf, type Series, type SeriesRow } from './series';

/** The series of one completed task: what its completion asks to check, and where each stands. */
export interface SeriesView {
  series: Series;
  rows: SeriesRow[];
  /** Whether the checks of every task that is to be checked have been read. */
  loaded: boolean;
  /** Why they could not be read, said once; nothing is shown as 0 in its place. */
  error: string | undefined;
  checked: number;
  total: number;
}

/**
 * The series of the given tasks, from what the page already has: the scope is computed by the
 * same function the server uses, and the state of each task from its history, read when this is
 * shown and kept current by the board's events (ADR-0030 §8) — so it comes back after a reload
 * and in another tab. It only reads: nothing here starts a check.
 */
export function useSeries(tasks: readonly Task[]): {
  views: Map<string, SeriesView>;
  retry: () => void;
} {
  const { state, store } = useBoard();
  const [failure, setFailure] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);

  const input: RevalidationInput = useMemo(
    () => ({
      tasks: state.tasks,
      topics: state.topics,
      statuses: state.project?.statuses ?? [],
      readIssues: state.project?.readIssues ?? [],
    }),
    [state.tasks, state.topics, state.project],
  );

  const scopes = useMemo(() => {
    const found = new Map<
      string,
      { series: Series; scope: ReturnType<typeof revalidationScope> }
    >();
    for (const task of tasks) {
      const series = seriesOf(task);
      if (series === undefined || !launchState(task, []).done) continue;
      const scope = revalidationScope(input, task.id);
      if (scope.length > 0) found.set(task.id, { series, scope });
    }
    return found;
  }, [tasks, input]);

  const wanted = useMemo(
    () =>
      [
        ...new Set(
          [...scopes.values()].flatMap(({ scope }) =>
            scope.filter((item) => item.excluded === undefined).map((item) => item.task),
          ),
        ),
      ].sort(),
    [scopes],
  );
  const wantedKey = wanted.join(',');

  useEffect(() => {
    let alive = true;
    for (const id of wantedKey === '' ? [] : wantedKey.split(',')) {
      store.loadHistory(id).then(
        () =>
          alive &&
          setFailure((current) => {
            if (current[id] === undefined) return current;
            const { [id]: _gone, ...rest } = current;
            return rest;
          }),
        (problem: unknown) =>
          alive &&
          setFailure((current) => ({
            ...current,
            [id]: problem instanceof Error ? problem.message : 'Something went wrong.',
          })),
      );
    }
    return () => {
      alive = false;
    };
  }, [store, wantedKey, attempt]);

  const views = useMemo(() => {
    const built = new Map<string, SeriesView>();
    for (const [id, { series, scope }] of scopes) {
      const needed = scope.filter((item) => item.excluded === undefined);
      const loaded = needed.every((item) => state.history[item.task] !== undefined);
      const rows: SeriesRow[] = scope.map((item) => ({
        ...item,
        state: itemState(state.history[item.task]?.checks ?? [], series),
      }));
      const missing = needed.find(
        (item) => state.history[item.task] === undefined && failure[item.task] !== undefined,
      );
      built.set(id, {
        series,
        rows,
        loaded,
        error: missing === undefined ? undefined : failure[missing.task],
        ...progress(rows),
      });
    }
    return built;
  }, [scopes, state.history, failure]);

  return { views, retry: useCallback(() => setAttempt((count) => count + 1), []) };
}
