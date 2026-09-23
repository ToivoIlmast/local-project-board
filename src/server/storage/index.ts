import type { Storage } from '../../core/ports.js';
import type { AppConfig } from '../config/schema.js';
import { STORAGE_PROVIDERS } from '../config/schema.js';
import { markdownStorage } from './markdown/index.js';

export interface StorageOptions {
  /** The board root (the main worktree). */
  root: string;
  onExternalChange?: (() => void) | undefined;
}

/** The only place that knows which providers exist (ADR-0002). */
export function createStorage(config: AppConfig, options: StorageOptions): Storage {
  switch (config.storage.provider) {
    case 'markdown':
      return markdownStorage({
        root: options.root,
        idPrefix: config.tasks.idPrefix,
        onExternalChange: options.onExternalChange,
      });
    default:
      throw new Error(
        `Unknown storage provider "${String(config.storage.provider)}". Available: ${STORAGE_PROVIDERS.join(', ')}`,
      );
  }
}
