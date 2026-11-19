import { DEFAULT_LANGUAGE, type UiLanguage } from './languages';
import { readStoredLanguage, writeStoredLanguage } from './storage';

/**
 * The current language, outside React so that plain functions (`formatDate`) can read it.
 * Components follow it through `useLanguage`.
 */
let current: UiLanguage | undefined;
const listeners = new Set<() => void>();

export function getLanguage(): UiLanguage {
  current ??= typeof window === 'undefined' ? DEFAULT_LANGUAGE : readStoredLanguage();
  return current;
}

function publish(language: UiLanguage): void {
  if (language === current) return;
  current = language;
  for (const listener of [...listeners]) listener();
}

export function setLanguage(language: UiLanguage): void {
  writeStoredLanguage(language);
  publish(language);
}

/** Take the saved choice again, as a page that has just been opened does. */
export function reloadLanguage(): void {
  publish(readStoredLanguage());
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
