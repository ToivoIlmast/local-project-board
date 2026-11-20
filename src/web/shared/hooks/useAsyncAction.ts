import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/common';

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
  const t = useT();
  // The board's own message, or an empty one when it said none: the generic words are chosen when shown.
  const [failed, setFailed] = useState<{ message: string } | undefined>(undefined);
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const aliveRef = useRef(true);

  const attempt = useCallback(
    async (...args: A): Promise<string | undefined> => {
      setPending(true);
      setFailed(undefined);
      try {
        await action(...args);
        return undefined;
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : '';
        setFailed({ message });
        return message !== '' ? message : tRef.current('ui.somethingWrong');
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

  const error = failed === undefined ? undefined : failed.message || t('ui.somethingWrong');

  return { run, attempt, pending, error, clearError: () => setFailed(undefined) };
}
