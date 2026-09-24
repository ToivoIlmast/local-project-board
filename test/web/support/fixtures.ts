import type { Project } from '../../../src/core/model/project';
import type { Task } from '../../../src/core/model/task';
import type { Report } from '../../../src/core/model/report';
import type { DocumentMeta } from '../../../src/core/model/document';
import type { GitStatus } from '../../../src/core/model/git';

export const STATUSES = ['backlog', 'todo', 'in-progress', 'done'];

export function aProject(overrides: Partial<Project> = {}): Project {
  return {
    name: 'dep-health',
    root: '/home/me/dep-health',
    statuses: [...STATUSES],
    idPrefix: 'T',
    storage: { provider: 'markdown' },
    git: { available: true, branch: 'main', detached: false },
    version: '0.1.0',
    readIssues: [],
    ...overrides,
  };
}

let sequence = 0;

export function aTask(overrides: Partial<Task> = {}): Task {
  sequence += 1;
  return {
    id: `T${sequence}`,
    title: `Task ${sequence}`,
    status: 'todo',
    rank: 'a0',
    body: '',
    labels: [],
    createdAt: '2026-09-21T09:00:00.000Z',
    updatedAt: '2026-09-21T09:00:00.000Z',
    ...overrides,
  };
}

export function aReport(overrides: Partial<Report> = {}): Report {
  return {
    id: 'R1',
    title: 'Dependency audit',
    format: 'html',
    createdAt: '2026-09-21T11:30:00.000Z',
    ...overrides,
  };
}

export function aDocument(overrides: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    taskId: 'T1',
    name: 'plan.md',
    size: 42,
    updatedAt: '2026-09-21T11:30:00.000Z',
    ...overrides,
  };
}

export function aGitStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    detached: false,
    clean: true,
    files: [],
    ...overrides,
  };
}
