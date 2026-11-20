import type { UiLanguage } from './languages';
import type { Message } from './messages';

/**
 * One row of a table in the order of `UI_LANGUAGES`: en, fi, sv, no, da, is, de, fr, es, pl,
 * pt, ru, ar, ja. Shorter to write and to compare against English than fourteen `key: value`.
 */
export function row(
  en: Message,
  fi: Message,
  sv: Message,
  no: Message,
  da: Message,
  is: Message,
  de: Message,
  fr: Message,
  es: Message,
  pl: Message,
  pt: Message,
  ru: Message,
  ar: Message,
  ja: Message,
): Record<UiLanguage, Message> {
  return { en, fi, sv, no, da, is, de, fr, es, pl, pt, ru, ar, ja };
}
