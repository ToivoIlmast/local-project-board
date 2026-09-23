import type { GitReader } from '../../core/ports.js';

/**
 * Git for a project that has none: a standalone snapshot, or a board in a plain directory
 * (ADR-0001). It answers, it never fails, and it invents nothing — no branch name, no commits.
 */
export function nullGitReader(): GitReader {
  return {
    available: async () => false,
    currentBranch: async () => ({ name: null, detached: false }),
    branches: async () => [],
    status: async () => ({ branch: null, detached: false, clean: true, files: [] }),
    commits: async () => [],
    diff: async () => ({ text: '', truncated: false }),
  };
}
