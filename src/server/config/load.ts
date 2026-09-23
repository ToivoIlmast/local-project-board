import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { ConfigError, type ConfigIssue } from './errors.js';
import {
  appConfigSchema,
  configLayerSchema,
  defaultConfig,
  type AppConfig,
  type ConfigLayer,
} from './schema.js';

export const PROJECT_CONFIG_FILE = 'board.config.yaml';

/** Flags accepted by the CLI; the names are the flags themselves. */
export interface CliOptions {
  port?: number | undefined;
  open?: boolean | undefined;
}

export interface LoadConfigOptions {
  /** The board root (the main worktree). */
  root: string;
  cli?: CliOptions;
  env?: Record<string, string | undefined>;
  /** ~/.config/local-project-board/config.yaml; absent is not an error. */
  userConfigPath?: string | undefined;
}

/** Environment variables, listed one by one: no magic mapping from names to config paths. */
const ENV_KEYS = {
  BOARD_PORT: 'server.port',
  BOARD_OPEN: 'server.open',
  BOARD_PROJECT_NAME: 'project.name',
  BOARD_ID_PREFIX: 'tasks.idPrefix',
  BOARD_STORAGE_PROVIDER: 'storage.provider',
} as const;

/**
 * CLI > env > board.config.yaml > user config > defaults. A layer overrides the single
 * values it sets, nothing else; a list is replaced as a whole.
 */
export async function loadConfig(options: LoadConfigOptions): Promise<AppConfig> {
  const root = resolve(options.root);
  const issues: ConfigIssue[] = [];

  const layers: ConfigLayer[] = [
    options.userConfigPath === undefined
      ? {}
      : await readLayer(options.userConfigPath, issues, true),
    await readLayer(join(root, PROJECT_CONFIG_FILE), issues, true),
    readEnv(options.env ?? {}, issues),
    readCli(options.cli ?? {}, issues),
  ];

  if (issues.length > 0) throw ConfigError.fromIssues(issues);

  const merged = layers.reduce<ConfigLayer>(mergeLayer, {});
  const config = mergeLayer(defaultConfig(basename(root)) as ConfigLayer, merged);
  const result = appConfigSchema.safeParse(config);
  if (!result.success) throw ConfigError.fromIssues(toIssues(result.error, 'the merged config'));
  return result.data;
}

async function readLayer(
  file: string,
  issues: ConfigIssue[],
  optional: boolean,
): Promise<ConfigLayer> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ConfigError(`Cannot read ${file}: ${(error as Error).message}`);
  }

  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`${file} is not valid YAML: ${(error as Error).message}`);
  }
  if (data === null || data === undefined) return {};

  const result = configLayerSchema.safeParse(data);
  if (!result.success) {
    issues.push(...toIssues(result.error, file));
    return {};
  }
  return result.data;
}

function readEnv(env: Record<string, string | undefined>, issues: ConfigIssue[]): ConfigLayer {
  const layer: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(ENV_KEYS)) {
    const raw = env[name];
    if (raw === undefined) continue;
    setPath(layer, path, path.endsWith('port') ? toNumber(raw) : toBoolean(raw));
  }
  return validateLayer(layer, issues, (path) => envNameOf(path) ?? 'the environment');
}

function readCli(cli: CliOptions, issues: ConfigIssue[]): ConfigLayer {
  const layer: Record<string, unknown> = {};
  if (cli.port !== undefined) setPath(layer, 'server.port', cli.port);
  if (cli.open !== undefined) setPath(layer, 'server.open', cli.open);
  return validateLayer(layer, issues, (path) => (path.endsWith('open') ? '--no-open' : '--port'));
}

function validateLayer(
  layer: Record<string, unknown>,
  issues: ConfigIssue[],
  source: (path: string) => string,
): ConfigLayer {
  const result = configLayerSchema.safeParse(layer);
  if (result.success) return result.data;
  issues.push(
    ...toIssues(result.error, '').map((issue) => ({ ...issue, source: source(issue.path) })),
  );
  return {};
}

/** `BOARD_OPEN=false`; anything that is not a boolean word stays a string and fails validation. */
function toBoolean(raw: string): unknown {
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return raw;
}

function toNumber(raw: string): unknown {
  const value = Number(raw);
  return raw.trim() === '' || Number.isNaN(value) ? raw : value;
}

function envNameOf(path: string): string | undefined {
  const suffix = path.replace(/^config\./, '');
  return Object.entries(ENV_KEYS).find(([, target]) => target === suffix)?.[0];
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const [section, key] = path.split('.');
  if (section === undefined || key === undefined) return;
  const current = (target[section] ?? {}) as Record<string, unknown>;
  current[key] = value;
  target[section] = current;
}

/** Sections merge key by key; everything else, including lists, is replaced. */
function mergeLayer(base: ConfigLayer, layer: ConfigLayer): ConfigLayer {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) continue;
    const current = merged[key];
    merged[key] = isPlainObject(current) && isPlainObject(value) ? { ...current, ...value } : value;
  }
  return merged as ConfigLayer;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toIssues(error: z.ZodError, source: string): ConfigIssue[] {
  return error.issues.map((issue) => {
    const path = ['config', ...issue.path.map(String)];
    if (issue.code === 'unrecognized_keys') path.push(...issue.keys);
    return { path: path.join('.'), message: issue.message, source };
  });
}
