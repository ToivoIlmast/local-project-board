import { useCallback, useRef, useState } from 'react';

export interface AsyncAction<A extends unknown[]> {
  run: (...args: A) => Promise<boolean>;
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

  const run = useCallback(
    async (...args: A): Promise<boolean> => {
      setPending(true);
      setError(undefined);
      try {
        await action(...args);
        return true;
      } catch (failure) {
        const message =
          failure instanceof Error && failure.message !== ''
            ? failure.message
            : 'Something went wrong.';
        setError(message);
        return false;
      } finally {
        if (aliveRef.current) setPending(false);
      }
    },
    [action],
  );

  return { run, pending, error, clearError: () => setError(undefined) };
}
