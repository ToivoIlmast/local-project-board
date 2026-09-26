import { useCallback, useRef, useState } from 'react';

export interface AsyncAction<A extends unknown[]> {
  run: (...args: A) => Promise<boolean>;
  /** Like `run`, but resolves to the message of the failure, or to nothing when it worked. */
  attempt: (...args: A) => Promise<string | undefined>;
  pending: boolean;
  error: string | undefined;
  clearError: () => void;
}

/**
 * Anything that goes to the board and may fail: the waiting and the failure are part of the
 * screen, not an afterthought. The message is the board's own — it already writes for a human.
 */
export function useAsyncAction<A extends unknown[]>(
  action: (...args: A) => Promise<unknown>,
): AsyncAction<A> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const aliveRef = useRef(true);

  const attempt = useCallback(
    async (...args: A): Promise<string | undefined> => {
      setPending(true);
      setError(undefined);
      try {
        await action(...args);
        return undefined;
      } catch (failure) {
        const message =
          failure instanceof Error && failure.message !== ''
            ? failure.message
            : 'Something went wrong.';
        setError(message);
        return message;
      } finally {
        if (aliveRef.current) setPending(false);
      }
    },
    [action],
  );

  const run = useCallback(
    async (...args: A): Promise<boolean> => (await attempt(...args)) === undefined,
    [attempt],
  );

  return { run, attempt, pending, error, clearError: () => setError(undefined) };
}
