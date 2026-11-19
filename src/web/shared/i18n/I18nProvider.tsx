import { useLayoutEffect, useState, type ReactNode } from 'react';
import { directionOf } from './languages';
import { reloadLanguage } from './store';
import { useLanguage } from './useLanguage';

/**
 * Reads the saved choice when the page opens and keeps `<html lang dir>` equal to the language.
 * Components need no provider to translate; they follow the store.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  // Once, before the first render of the children: the choice saved by an earlier visit.
  const [opened] = useState(() => {
    reloadLanguage();
    return true;
  });
  const language = useLanguage();
  useLayoutEffect(() => {
    if (!opened) return;
    const root = document.documentElement;
    root.lang = language;
    root.dir = directionOf(language);
  }, [language, opened]);
  return <>{children}</>;
}
