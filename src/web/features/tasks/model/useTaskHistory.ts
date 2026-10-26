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
  const history = state.history[taskId];
  // A failure belongs to what the page knew when it happened: a read that lands after it — the
  // page's own, or the one the store makes when the board is back — is newer, and the message is
  // no longer shown.
  const [failure, setFailure] = useState<{ message: string; seen: unknown } | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    store.loadHistory(taskId).then(
      () => alive && setFailure(undefined),
      (problem: unknown) =>
        alive &&
        setFailure({ message: messageOf(problem), seen: store.getState().history[taskId] }),
    );
    return () => {
      alive = false;
    };
  }, [store, taskId, attempt]);

  return {
    history,
    error: failure !== undefined && failure.seen === history ? failure.message : undefined,
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
  const check = state.checks[`${taskId}/${number}`];
  const [failure, setFailure] = useState<{ message: string; seen: unknown } | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    store.loadCheck(taskId, number).then(
      () => alive && setFailure(undefined),
      (problem: unknown) =>
        alive &&
        setFailure({
          message: messageOf(problem),
          seen: store.getState().checks[`${taskId}/${number}`],
        }),
    );
    return () => {
      alive = false;
    };
  }, [store, taskId, number, attempt]);

  return {
    check,
    error: failure !== undefined && failure.seen === check ? failure.message : undefined,
    retry: useCallback(() => setAttempt((count) => count + 1), []),
  };
}

/**
 * The markdown of a research report, read once it is published (ADR-0030 R3). It never changes,
 * so it is read when asked for and not again; nothing is read for an actuality check.
 */
export function useReportMarkdown(
  taskId: string,
  number: number,
  published: boolean,
): { markdown: string | undefined; error: string | undefined } {
  const { client } = useBoard();
  const key = `${taskId}/${number}`;
  const [read, setRead] = useState<{ key: string; markdown?: string; error?: string }>({ key });

  useEffect(() => {
    if (!published) return undefined;
    let alive = true;
    client.checkReportMarkdown(taskId, number).then(
      (markdown) => alive && setRead({ key, markdown }),
      (failure: unknown) => alive && setRead({ key, error: messageOf(failure) }),
    );
    return () => {
      alive = false;
    };
  }, [client, taskId, number, key, published]);

  // What was read for another report is never shown for this one.
  return read.key === key
    ? { markdown: read.markdown, error: read.error }
    : { markdown: undefined, error: undefined };
}
