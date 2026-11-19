/**
 * The languages of the interface. This is NOT the language of AI reports (`reportLanguage`,
 * ADR-0028): that is a setting of the work, this one is a choice of the person looking at the
 * board. `shared` may not import the contract, so the list is declared here and a test keeps
 * it equal to `SUPPORTED_LANGUAGES`.
 */
export const UI_LANGUAGES = [
  'en',
  'fi',
  'sv',
  'no',
  'da',
  'is',
  'de',
  'fr',
  'es',
  'pl',
  'pt',
  'ru',
  'ar',
  'ja',
] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: UiLanguage = 'en';

/** Each language in its own words, so that a person finds theirs from any interface. */
export const LANGUAGE_ENDONYMS: Record<UiLanguage, string> = {
  en: 'English',
  fi: 'Suomi',
  sv: 'Svenska',
  no: 'Norsk',
  da: 'Dansk',
  is: 'Íslenska',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pl: 'Polski',
  pt: 'Português',
  ru: 'Русский',
  ar: 'العربية',
  ja: '日本語',
};

const RIGHT_TO_LEFT: ReadonlySet<UiLanguage> = new Set<UiLanguage>(['ar']);

export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === 'string' && (UI_LANGUAGES as readonly string[]).includes(value);
}

export function directionOf(language: UiLanguage): 'ltr' | 'rtl' {
  return RIGHT_TO_LEFT.has(language) ? 'rtl' : 'ltr';
}
