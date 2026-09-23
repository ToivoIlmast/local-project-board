import type { Project } from '../model/project.js';
import type { GitReader, Storage } from '../ports.js';

export interface ProjectServiceOptions {
  storage: Storage;
  git: GitReader;
  /** Absolute path of the board root. */
  root: string;
  /** The package version, passed in: the core does not read files. */
  version: string;
  config: {
    name: string;
    statuses: string[];
    idPrefix: string;
    provider: string;
  };
}

export interface ProjectService {
  read(): Promise<Project>;
}

export function createProjectService({
  storage,
  git,
  root,
  version,
  config,
}: ProjectServiceOptions): ProjectService {
  return {
    async read() {
      const available = await git.available();
      const branch = available ? await git.currentBranch() : { name: null, detached: false };
      return {
        name: config.name,
        root,
        statuses: [...config.statuses],
        idPrefix: config.idPrefix,
        storage: { provider: config.provider },
        git: {
          available,
          // No branch name is invented for a detached HEAD or a directory without git.
          ...(branch.name === null ? {} : { branch: branch.name }),
          detached: branch.detached,
        },
        version,
        readIssues: await storage.readIssues(),
      };
    },
  };
}
