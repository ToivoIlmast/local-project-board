import { useSyncExternalStore } from 'react';
import type { UiLanguage } from './languages';
import { getLanguage, subscribeLanguage } from './store';

export function useLanguage(): UiLanguage {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}
