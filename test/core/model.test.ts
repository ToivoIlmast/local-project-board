import {
  boardSnapshotSchema,
  documentMetaSchema,
  projectSchema,
  reportSchema,
  statusesSchema,
  taskSchema,
  type Task,
} from '../../src/core/model/index.js';

const task: Task = {
  id: 'T1',
  title: 'Write the storage conformance suite',
  status: 'todo',
  rank: 'a0',
  body: '## Notes\n',
  labels: ['storage'],
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

describe('taskSchema', () => {
  it('accepts a valid task, with and without optional fields', () => {
    expect(taskSchema.parse(task)).toEqual(task);
    const full = { ...task, branch: 'feat/x', extra: { estimate: 3, owner: { name: 'me' } } };
    expect(taskSchema.parse(full)).toEqual(full);
  });

  it.each([
    ['id', { id: '../T1' }],
    ['id', { id: 't1' }],
    ['title', { title: '' }],
    ['title', { title: '   ' }],
    ['status', { status: '' }],
    ['rank', { rank: 'a00' }],
    ['rank', { rank: '' }],
    ['labels', { labels: [''] }],
    ['createdAt', { createdAt: 'yesterday' }],
    ['updatedAt', { updatedAt: '2026-09-21' }],
  ])('rejects an invalid %s', (field, override) => {
    const result = taskSchema.safeParse({ ...task, ...override });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path[0]).toBe(field);
  });

  it('rejects unknown top-level fields: they belong in `extra`', () => {
    expect(taskSchema.safeParse({ ...task, estimate: 3 }).success).toBe(false);
  });
});

describe('documentMetaSchema', () => {
  it('rejects a document name that is not safe as a file name', () => {
    const meta = { taskId: 'T1', name: 'notes.md', size: 10, updatedAt: task.updatedAt };
    expect(documentMetaSchema.safeParse(meta).success).toBe(true);
    expect(documentMetaSchema.safeParse({ ...meta, name: '../notes.md' }).success).toBe(false);
    expect(documentMetaSchema.safeParse({ ...meta, size: -1 }).success).toBe(false);
  });
});

describe('reportSchema', () => {
  it('accepts R-ids and the two formats only', () => {
    const report = { id: 'R1', title: 'Audit', format: 'html', createdAt: task.createdAt };
    expect(reportSchema.safeParse(report).success).toBe(true);
    expect(reportSchema.safeParse({ ...report, id: 'T1' }).success).toBe(false);
    expect(reportSchema.safeParse({ ...report, format: 'pdf' }).success).toBe(false);
  });
});

describe('statusesSchema', () => {
  it('requires at least one status, all non-empty and unique', () => {
    expect(statusesSchema.safeParse(['todo', 'done']).success).toBe(true);
    expect(statusesSchema.safeParse([]).success).toBe(false);
    expect(statusesSchema.safeParse(['todo', '']).success).toBe(false);
    expect(statusesSchema.safeParse(['todo', 'todo']).success).toBe(false);
  });
});

describe('projectSchema', () => {
  it('validates the id prefix', () => {
    const project = {
      name: 'dep-health',
      root: '/home/me/dep-health',
      statuses: ['todo', 'done'],
      idPrefix: 'F',
      storage: { provider: 'markdown' },
      git: { available: true, branch: 'main', detached: false },
      version: '0.1.0',
    };
    expect(projectSchema.safeParse(project).success).toBe(true);
    expect(projectSchema.safeParse({ ...project, idPrefix: 'f' }).success).toBe(false);
  });
});

describe('boardSnapshotSchema', () => {
  const snapshot = {
    formatVersion: 1,
    exportedAt: task.createdAt,
    project: { name: 'dep-health', statuses: ['todo', 'done'], idPrefix: 'T' },
    tasks: [task],
    documents: [{ taskId: 'T1', name: 'notes.md', content: '# Notes\n' }],
    reports: [
      { id: 'R1', title: 'Audit', format: 'html', createdAt: task.createdAt, content: '<p>x</p>' },
    ],
  };

  it('accepts a complete snapshot', () => {
    expect(boardSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('accepts only format version 1', () => {
    expect(boardSnapshotSchema.safeParse({ ...snapshot, formatVersion: 2 }).success).toBe(false);
  });

  it('rejects unsafe document names inside a snapshot', () => {
    const bad = { ...snapshot, documents: [{ taskId: 'T1', name: '../x.md', content: '' }] };
    expect(boardSnapshotSchema.safeParse(bad).success).toBe(false);
  });
});
