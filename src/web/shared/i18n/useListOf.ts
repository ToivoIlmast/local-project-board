import { useCallback } from 'react';
import { useLanguage } from './useLanguage';

/** "a, b and c" in the language shown; English keeps no comma before the "and". */
export function useListOf(): (items: readonly string[]) => string {
  const language = useLanguage();
  return useCallback(
    (items) =>
      new Intl.ListFormat(language === 'en' ? 'en-GB' : language, {
        style: 'long',
        type: 'conjunction',
      }).format(items),
    [language],
  );
}
