import { DEFAULT_LANGUAGE, isUiLanguage, type UiLanguage } from './languages';

export const LANGUAGE_STORAGE_KEY = 'board.language';

/** The saved choice; no choice, an unknown value or storage that throws all mean English. */
export function readStoredLanguage(): UiLanguage {
  try {
    const value = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isUiLanguage(value) ? value : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function writeStoredLanguage(language: UiLanguage): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // The choice then lasts until the page is closed, which is all that can be done.
  }
}
