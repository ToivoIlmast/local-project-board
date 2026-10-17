import type { Project } from '../../../src/core/model/project';
import type { Task } from '../../../src/core/model/task';
import type { Report } from '../../../src/core/model/report';
import type { Check } from '../../../src/core/model/history';
import type { DocumentMeta } from '../../../src/core/model/document';
import type { GitStatus } from '../../../src/core/model/git';
import type { EffectiveWorkflow, WorkflowState } from '../../../src/core/model/workflow';
import { DEFAULT_WORKFLOW, defaultWorkflow } from '../../../src/core/rules/workflow';

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

export function aWorkflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    defaults: defaultWorkflow(STATUSES),
    board: {},
    statuses: {},
    ...overrides,
  };
}

export function anEffectiveWorkflow(overrides: Partial<EffectiveWorkflow> = {}): EffectiveWorkflow {
  return {
    values: { ...DEFAULT_WORKFLOW },
    sources: {
      editCode: 'default',
      branch: 'default',
      checks: 'default',
      commit: 'default',
      push: 'default',
      report: 'default',
      startStatus: 'default',
      finishStatus: 'default',
      baseBranch: 'default',
      checkCommand: 'default',
      commitLanguage: 'default',
      reportLanguage: 'default',
    },
    inactive: [],
    ...overrides,
  };
}

const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';

/** A check that has its report: one finding, a recommendation with an edit and one piece of advice. */
export function aCheck(overrides: Partial<Check> = {}, taskId = 'T1', number = 1): Check {
  return {
    state: 'reported',
    begin: {
      taskId,
      number,
      version: 1,
      createdAt: '2026-10-17T10:00:00.000Z',
      agent: 'claude-code',
      sessionId: SESSION,
      repo: { branch: 'main', head: '9f1c1a2b3c4d5e6f', clean: true },
    },
    report: {
      taskId,
      check: number,
      version: 1,
      createdAt: '2026-10-17T10:05:00.000Z',
      agent: 'claude-code',
      verdict: 'partly-outdated',
      summary: 'One path moved.',
      uncertainty: 'The tests were not run.',
      findings: [
        {
          id: 'f1',
          title: 'The adapter was moved',
          explanation: 'It now lives in src/server/git.',
          evidence: [{ kind: 'file', ref: 'src/server/git/reader.ts', note: 'new place' }],
        },
      ],
      recommendations: [
        {
          id: 'r1',
          findings: ['f1'],
          text: 'Update the path.',
          edit: { field: 'body', find: 'src/git.ts', replace: 'src/server/git/reader.ts' },
        },
        { id: 'r2', findings: [], text: 'Ask the owner about the second criterion.' },
      ],
      repo: { branch: 'main', head: '9f1c1a2b3c4d5e6f', clean: true },
    },
    decisions: [],
    ...overrides,
  };
}
