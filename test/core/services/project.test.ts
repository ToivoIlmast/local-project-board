import { projectSchema } from '../../../src/core/model/index.js';
import type { GitReader, Storage } from '../../../src/core/ports.js';
import { createProjectService } from '../../../src/core/services/project.js';
import { createMemoryStore, inMemoryStorage } from '../../support/inMemoryStorage.js';

const gitStub = (over: Partial<GitReader> = {}): GitReader =>
  ({
    available: async () => true,
    currentBranch: async () => ({ name: 'main', detached: false }),
    branches: async () => [],
    status: async () => ({ branch: 'main', detached: false, clean: true, files: [] }),
    commits: async () => [],
    diff: async () => ({ text: '', truncated: false }),
    ...over,
  }) as GitReader;

function service(storage: Storage, git: GitReader) {
  return createProjectService({
    storage,
    git,
    root: '/home/me/dep-health',
    version: '0.1.0',
    config: {
      name: 'dep-health',
      statuses: ['todo', 'done'],
      idPrefix: 'F',
      provider: 'markdown',
    },
  });
}

describe('ProjectService', () => {
  let storage: Storage;

  beforeEach(async () => {
    storage = inMemoryStorage(createMemoryStore());
    await storage.init();
  });

  it('describes the board from the config, git and storage', async () => {
    const project = await service(storage, gitStub()).read();
    expect(projectSchema.parse(project)).toEqual(project);
    expect(project).toEqual({
      name: 'dep-health',
      root: '/home/me/dep-health',
      statuses: ['todo', 'done'],
      idPrefix: 'F',
      storage: { provider: 'markdown' },
      git: { available: true, branch: 'main', detached: false },
      version: '0.1.0',
      readIssues: [],
    });
  });

  it('works in a directory that is not a git repository', async () => {
    const git = gitStub({
      available: async () => false,
      currentBranch: async () => ({ name: null, detached: false }),
    });
    const project = await service(storage, git).read();
    expect(project.git).toEqual({ available: false, detached: false });
  });

  it('reports a detached HEAD without inventing a branch name', async () => {
    const git = gitStub({ currentBranch: async () => ({ name: null, detached: true }) });
    const project = await service(storage, git).read();
    expect(project.git).toEqual({ available: true, detached: true });
  });

  it('passes on what the storage could not read (ADR-0022)', async () => {
    const failing: Storage = {
      ...storage,
      readIssues: async () => [{ file: 'tasks/T7/task.md', message: 'Invalid YAML frontmatter' }],
    };
    const project = await service(failing, gitStub()).read();
    expect(project.readIssues).toEqual([
      { file: 'tasks/T7/task.md', message: 'Invalid YAML frontmatter' },
    ]);
  });
});
