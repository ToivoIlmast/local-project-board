/**
 * The 14 languages supported for AI-generated reports (ADR-0028). Matches dep-health-analyzer.
 * English (en) is the default when no language is set (reportLanguage: null).
 */
export const SUPPORTED_LANGUAGES = [
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

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Human-readable name for each supported language code. */
export const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  en: 'English',
  fi: 'Finnish',
  sv: 'Swedish',
  no: 'Norwegian',
  da: 'Danish',
  is: 'Icelandic',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  pl: 'Polish',
  pt: 'Portuguese',
  ru: 'Russian',
  ar: 'Arabic',
  ja: 'Japanese',
};

/** The name to display for a language code; falls back to the code for unknown values. */
export function languageName(code: string): string {
  return LANGUAGE_NAMES[code as SupportedLanguage] ?? code;
}
