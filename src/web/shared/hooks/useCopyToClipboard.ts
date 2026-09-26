import { useCallback, useState } from 'react';

/** Copy, and say so. Without a clipboard the button says what happened instead of lying. */
export function useCopyToClipboard(): {
  /** Resolves to whether the text is on the clipboard now. */
  copy: (text: string) => Promise<boolean>;
  state: 'idle' | 'copied' | 'failed';
} {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
      return true;
    } catch {
      setState('failed');
      return false;
    }
  }, []);

  return { copy, state };
}
