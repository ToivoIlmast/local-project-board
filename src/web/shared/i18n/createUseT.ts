import { useCallback } from 'react';
import { lookup, type Catalogs } from './catalog';
import { formatMessage, type MessageParams } from './messages';
import { useLanguage } from './useLanguage';

export type Translate<K extends string> = (key: K, params?: MessageParams) => string;

/**
 * The hook of one catalog. A feature defines its catalogs next to itself and exports the hook
 * made here; a key that is not in the catalog does not compile.
 */
export function createUseT<K extends string>(catalogs: Catalogs<K>): () => Translate<K> {
  return function useT(): Translate<K> {
    const language = useLanguage();
    return useCallback(
      (key, params) => formatMessage(language, lookup(catalogs, language, key), params),
      [language],
    );
  };
}
