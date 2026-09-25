import { z } from 'zod';
import { statusesSchema, taskIdPrefixSchema } from '../../core/model/project.js';
import { DEFAULT_AI_RULES } from '../../core/rules/aiRules.js';

/** The only storage provider in the MVP; the list is what the error message offers. */
export const STORAGE_PROVIDERS = ['markdown'] as const;

const section = {
  project: z.strictObject({ name: z.string().min(1) }),
  tasks: z.strictObject({ idPrefix: taskIdPrefixSchema }),
  storage: z.strictObject({
    provider: z.enum(STORAGE_PROVIDERS, {
      error: () => `Unknown storage provider. Available: ${STORAGE_PROVIDERS.join(', ')}`,
    }),
  }),
  server: z.strictObject({
    port: z.int().min(1).max(65535),
    /** Open the browser on start. */
    open: z.boolean(),
  }),
  ai: z.strictObject({
    allowSourceEdits: z.boolean(),
    /** The "## Rules" lines of the generated AI instructions; replaces the whole list. */
    rules: z.array(z.string().min(1)),
  }),
};

/** The validated result: every value is present, so nothing downstream deals with defaults. */
export const appConfigSchema = z.strictObject({
  project: section.project,
  statuses: statusesSchema,
  tasks: section.tasks,
  storage: section.storage,
  server: section.server,
  ai: section.ai,
});

/**
 * What one layer (a file, the environment, the flags) may say. Every key is optional, and
 * unknown keys are an error — a typo must not be ignored just because a default exists.
 * Plugin configuration is deliberately absent: it arrives with a real plugin contract.
 */
export const configLayerSchema = z.strictObject({
  project: section.project.partial().optional(),
  statuses: statusesSchema.optional(),
  tasks: section.tasks.partial().optional(),
  storage: section.storage.partial().optional(),
  server: section.server.partial().optional(),
  ai: section.ai.partial().optional(),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type ConfigLayer = z.infer<typeof configLayerSchema>;

export const DEFAULT_STATUSES = ['backlog', 'todo', 'in-progress', 'done'];
export const DEFAULT_PORT = 7432;

export function defaultConfig(projectName: string): AppConfig {
  return {
    project: { name: projectName },
    statuses: [...DEFAULT_STATUSES],
    tasks: { idPrefix: 'T' },
    storage: { provider: 'markdown' },
    server: { port: DEFAULT_PORT, open: true },
    ai: { allowSourceEdits: false, rules: [...DEFAULT_AI_RULES] },
  };
}
