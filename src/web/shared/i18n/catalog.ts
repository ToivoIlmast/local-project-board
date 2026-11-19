import type { UiLanguage } from './languages';
import type { Message } from './messages';

/** One catalog per language, each with every key of English: a missing one does not compile. */
export type Catalogs<K extends string> = Record<UiLanguage, Record<K, Message>>;

const registry: Catalogs<string>[] = [];

/** Every catalog defined so far, for the test that each is complete. */
export function registeredCatalogs(): readonly Catalogs<string>[] {
  return registry;
}

export function defineCatalogs<K extends string>(catalogs: Catalogs<K>): Catalogs<K> {
  registry.push(catalogs);
  return catalogs;
}

/** English is the reference: a key missing in the language shown falls back to it. */
export function lookup<K extends string>(
  catalogs: Catalogs<K>,
  language: UiLanguage,
  key: K,
): Message {
  return catalogs[language][key] ?? catalogs.en[key];
}

/** One row per key, each with the 14 languages: easier to write and to check against English. */
export type Table<K extends string> = Record<K, Record<UiLanguage, Message>>;

/** The same as `defineCatalogs`, for a table written key by key. */
export function defineTable<K extends string>(table: Table<K>): Catalogs<K> {
  const keys = Object.keys(table) as K[];
  const languages = Object.keys(table[keys[0] as K]) as UiLanguage[];
  const catalogs = Object.fromEntries(
    languages.map((language) => [
      language,
      Object.fromEntries(keys.map((key) => [key, table[key][language]])),
    ]),
  ) as Catalogs<K>;
  return defineCatalogs(catalogs);
}
