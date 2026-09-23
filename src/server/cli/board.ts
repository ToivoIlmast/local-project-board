import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '../config/index.js';
import { resolveBoardRoot } from '../project/boardRoot.js';
import type { ParsedArgs } from './args.js';

export interface BoardEnvironment {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** The two things every command needs before it can do anything: where and how. */
export interface ResolvedBoard {
  root: string;
  config: AppConfig;
}

/**
 * The first half of the composition root, shared by every command: find the board (one
 * implementation, in `server/project`), then read the configuration with the flags of this
 * very command on top of it (§11). Nothing here knows about HTTP.
 */
export async function resolveBoard(
  args: ParsedArgs,
  environment: BoardEnvironment,
): Promise<ResolvedBoard> {
  const root = await resolveBoardRoot(environment.cwd);
  const config = await loadConfig({
    root,
    env: environment.env,
    userConfigPath: userConfigPath(environment.env),
    cli: {
      ...(args.port === undefined ? {} : { port: args.port }),
      ...(args.open === undefined ? {} : { open: args.open }),
    },
  });
  return { root, config };
}

/** ~/.config/local-project-board/config.yaml, or wherever XDG_CONFIG_HOME points. */
export function userConfigPath(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'local-project-board', 'config.yaml');
}

/** What the board tells an agent about itself; the same facts feed the instructions. */
export function boardFacts(config: AppConfig): {
  name: string;
  statuses: string[];
  idPrefix: string;
} {
  return {
    name: config.project.name,
    statuses: [...config.statuses],
    idPrefix: config.tasks.idPrefix,
  };
}
