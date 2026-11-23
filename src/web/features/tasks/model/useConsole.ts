import { useCallback, useEffect, useState } from 'react';
import { useBoard } from '../../../api/react';
import type { ConsoleJournal } from '../../../api/index';
import { useT } from '../../../shared/i18n/index';

/**
 * The console of one run, read when it is opened and kept current by the board's events while it
 * is open (plan C9). Closing it drops what was read: the store keeps no console nobody looks at.
 * A failed read is said, and can be tried again, rather than left as an empty feed.
 */
export function useConsole(
  taskId: string,
  runId: number,
): { journal: ConsoleJournal | undefined; error: string | undefined; retry: () => void } {
  const { state, store } = useBoard();
  const t = useT();
  const journal = state.consoles[`${taskId}/${runId}`];
  // A failure belongs to what the page knew when it happened: a read that lands after it is newer.
  const [failure, setFailure] = useState<{ message: string; seen: unknown } | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    store.loadConsole(taskId, runId).then(
      () => alive && setFailure(undefined),
      (problem: unknown) =>
        alive &&
        setFailure({
          message: problem instanceof Error ? problem.message : '',
          seen: store.getState().consoles[`${taskId}/${runId}`],
        }),
    );
    return () => {
      alive = false;
      store.releaseConsole(taskId, runId);
    };
  }, [store, taskId, runId, attempt]);

  const failed = failure !== undefined && failure.seen === journal ? failure.message : undefined;
  return {
    journal,
    error: failed === undefined ? undefined : failed === '' ? t('ui.somethingWrong') : failed,
    retry: useCallback(() => setAttempt((count) => count + 1), []),
  };
}
