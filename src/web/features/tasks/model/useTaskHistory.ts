import { useCallback, useEffect, useState } from 'react';
import type { Check, TaskVersion } from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';
import type { TaskHistory } from '../../../api/index';

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'Something went wrong.';
}

/**
 * The history of one task, read when it is opened and kept current by the board's events after
 * that (ADR-0030 §8). What is shown is what the board last said; a failed read is said, and can
 * be tried again, rather than left as an empty list that looks like "no history".
 */
export function useTaskHistory(taskId: string): {
  history: TaskHistory | undefined;
  error: string | undefined;
  retry: () => void;
} {
  const { state, store } = useBoard();
  const [error, setError] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    store.loadHistory(taskId).then(
      () => alive && setError(undefined),
      (failure: unknown) => alive && setError(messageOf(failure)),
    );
    return () => {
      alive = false;
    };
  }, [store, taskId, attempt]);

  return {
    history: state.history[taskId],
    error,
    retry: useCallback(() => setAttempt((count) => count + 1), []),
  };
}

/** One version with its snapshot, once it is read; nothing while it is not asked for. */
export function useVersion(
  taskId: string,
  number: number | undefined,
): { version: TaskVersion | undefined; error: string | undefined } {
  const { state, store } = useBoard();
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (number === undefined) return undefined;
    let alive = true;
    store.loadVersion(taskId, number).then(
      () => alive && setError(undefined),
      (failure: unknown) => alive && setError(messageOf(failure)),
    );
    return () => {
      alive = false;
    };
  }, [store, taskId, number]);

  return {
    version: number === undefined ? undefined : state.snapshots[`${taskId}/${number}`],
    error: number === undefined ? undefined : error,
  };
}

/** One check, once it is read, and read again whenever the board says it was updated. */
export function useCheck(
  taskId: string,
  number: number,
): { check: Check | undefined; error: string | undefined; retry: () => void } {
  const { state, store } = useBoard();
  const [error, setError] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    store.loadCheck(taskId, number).then(
      () => alive && setError(undefined),
      (failure: unknown) => alive && setError(messageOf(failure)),
    );
    return () => {
      alive = false;
    };
  }, [store, taskId, number, attempt]);

  return {
    check: state.checks[`${taskId}/${number}`],
    error,
    retry: useCallback(() => setAttempt((count) => count + 1), []),
  };
}
