import { useCallback, useState } from 'react';

/** Copy, and say so. Without a clipboard the button says what happened instead of lying. */
export function useCopyToClipboard(): {
  copy: (text: string) => Promise<void>;
  state: 'idle' | 'copied' | 'failed';
} {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  }, []);

  return { copy, state };
}
