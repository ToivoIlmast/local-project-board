import type { UiLanguage } from './languages';

/** The plural categories of `Intl.PluralRules`; `other` is always needed. */
export type PluralMessage = { other: string } & Partial<
  Record<'zero' | 'one' | 'two' | 'few' | 'many', string>
>;

/** A text, or the forms of a text that depends on `count`. Parameters are written `{name}`. */
export type Message = string | PluralMessage;

export type MessageParams = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{(\w+)\}/g;

export function interpolate(text: string, params: MessageParams | undefined): string {
  if (params === undefined) return text;
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** The names of the `{placeholders}` of every form of a message, sorted and without repeats. */
export function placeholdersOf(message: Message): string[] {
  const texts = typeof message === 'string' ? [message] : Object.values(message);
  const names = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1] ?? '');
  }
  return [...names].sort();
}

export function formatMessage(
  language: UiLanguage,
  message: Message,
  params: MessageParams | undefined,
): string {
  if (typeof message === 'string') return interpolate(message, params);
  const count = params?.['count'];
  const category =
    typeof count === 'number' ? new Intl.PluralRules(language).select(count) : 'other';
  return interpolate(message[category] ?? message.other, params);
}
