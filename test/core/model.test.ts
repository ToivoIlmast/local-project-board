import {
  boardSnapshotSchema,
  checkBeginSchema,
  checkReportSchema,
  recommendationSchema,
  researchReportContentSchema,
  RESEARCH_MARKDOWN_MAX_LENGTH,
  documentMetaSchema,
  projectSchema,
  reportSchema,
  statusesSchema,
  taskSchema,
  boardWorkflowSchema,
  workflowFlagsSchema,
  workflowOverridesSchema,
  SUPPORTED_LANGUAGES,
  taskWorkflowSchema,
  workflowSettingsSchema,
  BOARD_ONLY_WORKFLOW_KEYS,
  BOARD_WORKFLOW_KEYS,
  TASK_WORKFLOW_KEYS,
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

  it('accepts partial workflow overrides and does not require them', () => {
    expect(taskSchema.parse({ ...task, workflow: { push: true } }).workflow).toEqual({
      push: true,
    });
    expect(taskSchema.parse({ ...task, workflow: {} }).workflow).toEqual({});
    expect('workflow' in taskSchema.parse(task)).toBe(false);
  });

  it.each([
    ['not a boolean', { push: 'yes' }],
    ['a setting only the board has', { checkCommand: 'npm test' }],
    ['an unknown setting', { allowSourceEdits: true }],
  ])('rejects task workflow overrides that are %s', (_why, workflow) => {
    const result = taskSchema.safeParse({ ...task, workflow });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path[0]).toBe('workflow');
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
      readIssues: [{ file: 'tasks/T7/task.md', message: 'Invalid YAML frontmatter' }],
    };
    expect(projectSchema.safeParse(project).success).toBe(true);
    expect(projectSchema.safeParse({ ...project, idPrefix: 'f' }).success).toBe(false);
  });
});

describe('workflowFlagsSchema', () => {
  it('accepts any subset of the six boolean settings', () => {
    expect(workflowFlagsSchema.parse({})).toEqual({});
    const all = {
      editCode: true,
      branch: true,
      checks: false,
      commit: true,
      push: false,
      report: true,
    };
    expect(workflowFlagsSchema.parse(all)).toEqual(all);
  });

  it.each([{ push: 1 }, { push: null }, { push: 'true' }, { startStatus: 'todo' }, { nope: true }])(
    'rejects %j',
    (value) => {
      expect(workflowFlagsSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('boardWorkflowSchema', () => {
  it('adds the settings that only make sense for the whole board', () => {
    const board = {
      push: true,
      startStatus: 'todo',
      finishStatus: null,
      baseBranch: 'develop',
      checkCommand: 'npm test',
    };
    expect(boardWorkflowSchema.parse(board)).toEqual(board);
  });

  it.each([
    { startStatus: '' },
    { baseBranch: '' },
    { checkCommand: '   ' },
    { checkCommand: 5 },
    { nope: true },
  ])('rejects %j', (value) => {
    expect(boardWorkflowSchema.safeParse(value).success).toBe(false);
  });
});

describe('workflowOverridesSchema', () => {
  it('holds the board overrides and the overrides of each column', () => {
    const workflow = {
      board: { push: false, checkCommand: 'npm test' },
      statuses: { backlog: { editCode: false } },
    };
    expect(workflowOverridesSchema.parse(workflow)).toEqual(workflow);
  });

  it('needs both parts and rejects anything else', () => {
    expect(workflowOverridesSchema.safeParse({ board: {} }).success).toBe(false);
    expect(workflowOverridesSchema.safeParse({ board: {}, statuses: {}, extra: 1 }).success).toBe(
      false,
    );
    // A column cannot carry board-only settings.
    expect(
      workflowOverridesSchema.safeParse({ board: {}, statuses: { todo: { baseBranch: 'x' } } })
        .success,
    ).toBe(false);
  });
});

describe('boardSnapshotSchema', () => {
  const snapshot = {
    formatVersion: 3,
    exportedAt: task.createdAt,
    project: { name: 'dep-health', statuses: ['todo', 'done'], idPrefix: 'T' },
    workflow: { board: { push: false }, statuses: { todo: { editCode: false } } },
    tasks: [{ ...task, workflow: { push: true } }],
    documents: [{ taskId: 'T1', name: 'notes.md', content: '# Notes\n' }],
    reports: [
      { id: 'R1', title: 'Audit', format: 'html', createdAt: task.createdAt, content: '<p>x</p>' },
    ],
    history: [
      {
        taskId: 'T1',
        versions: [
          {
            taskId: 'T1',
            number: 1,
            createdAt: task.createdAt,
            source: 'create',
            changed: [],
            snapshot: { title: task.title, body: task.body, labels: task.labels },
          },
        ],
        checks: [],
      },
    ],
  };

  it('accepts a complete snapshot', () => {
    expect(boardSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('accepts only format version 3: the history changed the shape of version 2', () => {
    expect(boardSnapshotSchema.safeParse({ ...snapshot, formatVersion: 1 }).success).toBe(false);
    expect(boardSnapshotSchema.safeParse({ ...snapshot, formatVersion: 2 }).success).toBe(false);
  });

  it('carries the history of every task', () => {
    const { history: _dropped, ...withoutHistory } = snapshot;
    expect(boardSnapshotSchema.safeParse(withoutHistory).success).toBe(false);
  });

  it('carries the workflow overrides, and only overrides', () => {
    const { workflow: _dropped, ...withoutWorkflow } = snapshot;
    expect(boardSnapshotSchema.safeParse(withoutWorkflow).success).toBe(false);
    const effective = { ...snapshot, workflow: { ...snapshot.workflow, sources: {}, values: {} } };
    expect(boardSnapshotSchema.safeParse(effective).success).toBe(false);
  });

  it('rejects unsafe document names inside a snapshot', () => {
    const bad = { ...snapshot, documents: [{ taskId: 'T1', name: '../x.md', content: '' }] };
    expect(boardSnapshotSchema.safeParse(bad).success).toBe(false);
  });
});

describe('reportLanguage (T34)', () => {
  // The list of dep-health's i18n.test.ts, in its order: English first, as the default.
  const EXPECTED = [
    'en',
    'fi',
    'sv',
    'no',
    'da',
    'is',
    'de',
    'fr',
    'es',
    'pl',
    'pt',
    'ru',
    'ar',
    'ja',
  ];

  it('is exactly the 14 languages of dep-health, no more and no fewer', () => {
    expect([...SUPPORTED_LANGUAGES]).toEqual(EXPECTED);
  });

  it.each(EXPECTED)('the board accepts %s, and the task too', (language) => {
    expect(boardWorkflowSchema.parse({ reportLanguage: language })).toEqual({
      reportLanguage: language,
    });
    expect(taskWorkflowSchema.parse({ reportLanguage: language })).toEqual({
      reportLanguage: language,
    });
  });

  it('the board still accepts null: that is English, as before', () => {
    expect(boardWorkflowSchema.parse({ reportLanguage: null })).toEqual({ reportLanguage: null });
  });

  it.each([
    { reportLanguage: 'xx' },
    { reportLanguage: 'English' },
    { reportLanguage: '' },
    { reportLanguage: 'FI' },
  ])('rejects %j on the board and on a task', (value) => {
    expect(boardWorkflowSchema.safeParse(value).success).toBe(false);
    expect(taskWorkflowSchema.safeParse(value).success).toBe(false);
  });

  it('a task has no null: "like the board" is the key removed, not a value', () => {
    expect(taskWorkflowSchema.safeParse({ reportLanguage: null }).success).toBe(false);
  });

  it('a task can still set the six flags next to the language, and no other board setting', () => {
    expect(taskWorkflowSchema.parse({ push: true, reportLanguage: 'fi' })).toEqual({
      push: true,
      reportLanguage: 'fi',
    });
    expect(taskWorkflowSchema.safeParse({ baseBranch: 'x' }).success).toBe(false);
  });

  it('a column cannot override it (INVARIANT: board+task, not column)', () => {
    expect(workflowFlagsSchema.safeParse({ reportLanguage: 'fi' }).success).toBe(false);
    expect(
      workflowOverridesSchema.safeParse({ board: {}, statuses: { todo: { reportLanguage: 'fi' } } })
        .success,
    ).toBe(false);
  });

  it('a task carries it in its own overrides', () => {
    const withLanguage = { ...task, workflow: { reportLanguage: 'fi' } };
    expect(taskSchema.parse(withLanguage)).toEqual(withLanguage);
    expect(taskSchema.safeParse({ ...task, workflow: { reportLanguage: 'xx' } }).success).toBe(
      false,
    );
  });
});

describe('commitLanguage (T43)', () => {
  it('the board accepts exactly the codes of reportLanguage: one source, not a copy', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      expect(boardWorkflowSchema.parse({ commitLanguage: language })).toEqual({
        commitLanguage: language,
      });
    }
    expect(boardWorkflowSchema.parse({ commitLanguage: null })).toEqual({ commitLanguage: null });
  });

  it.each(['xx', '', 'Finnish', 'FI', 'English'])('rejects %j on the board', (value) => {
    expect(boardWorkflowSchema.safeParse({ commitLanguage: value }).success).toBe(false);
  });

  it('a column cannot override it (INVARIANT: board only)', () => {
    expect(workflowFlagsSchema.safeParse({ commitLanguage: 'fi' }).success).toBe(false);
    expect(
      workflowOverridesSchema.safeParse({ board: {}, statuses: { todo: { commitLanguage: 'fi' } } })
        .success,
    ).toBe(false);
  });

  it('a task cannot override it (INVARIANT: board only)', () => {
    expect(taskWorkflowSchema.safeParse({ commitLanguage: 'fi' }).success).toBe(false);
    expect(taskSchema.safeParse({ ...task, workflow: { commitLanguage: 'fi' } }).success).toBe(
      false,
    );
  });

  it('is a board-only key, and is not one a task may override', () => {
    expect(BOARD_ONLY_WORKFLOW_KEYS as readonly string[]).toContain('commitLanguage');
    expect(BOARD_WORKFLOW_KEYS as readonly string[]).toContain('commitLanguage');
    expect(TASK_WORKFLOW_KEYS as readonly string[]).not.toContain('commitLanguage');
  });

  it('is a key of the settings a task runs with, and null by default', () => {
    expect(workflowSettingsSchema.shape).toHaveProperty('commitLanguage');
    expect(workflowSettingsSchema.shape.commitLanguage.safeParse('xx').success).toBe(false);
  });
});

describe('research in the history of a task (ADR-0030 R1–R4)', () => {
  const at = '2026-10-24T10:00:00.000Z';
  const begin = {
    taskId: 'T1',
    number: 1,
    version: 1,
    createdAt: at,
    agent: 'claude-code',
    sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
    repo: null,
  };
  const research = {
    agent: 'claude-code',
    summary: 'The task is clear.',
    findings: [],
    recommendations: [],
    markdown: '# Research\n',
  };
  const storedReport = {
    taskId: 'T1',
    check: 1,
    version: 1,
    createdAt: at,
    agent: 'claude-code',
    summary: 'The task is clear.',
    findings: [],
    recommendations: [],
    repo: null,
  };

  it('reads a begin without kind as an actuality check: files written before stay valid (INVARIANT)', () => {
    const parsed = checkBeginSchema.parse(begin);
    expect(parsed).toEqual(begin);
    expect(parsed).not.toHaveProperty('kind');
  });

  it('takes kind, comment and documents on a research begin, and only there', () => {
    const documents = [{ name: 'plan.md', size: 12, updatedAt: at }];
    const full = { ...begin, kind: 'research', comment: 'Look at the API.', documents };
    expect(checkBeginSchema.parse(full)).toEqual(full);

    expect(checkBeginSchema.safeParse({ ...begin, comment: 'x' }).success).toBe(false);
    expect(checkBeginSchema.safeParse({ ...begin, documents }).success).toBe(false);
    expect(checkBeginSchema.safeParse({ ...begin, kind: 'work' }).success).toBe(false);
  });

  it('limits the comment: not empty, no NUL, at most 4 000 characters (D12)', () => {
    const research = { ...begin, kind: 'research' };
    expect(checkBeginSchema.safeParse({ ...research, comment: 'x'.repeat(4000) }).success).toBe(
      true,
    );
    expect(checkBeginSchema.safeParse({ ...research, comment: 'x'.repeat(4001) }).success).toBe(
      false,
    );
    expect(checkBeginSchema.safeParse({ ...research, comment: '' }).success).toBe(false);
    expect(checkBeginSchema.safeParse({ ...research, comment: 'a\0b' }).success).toBe(false);
  });

  it('lists documents by name, size and time, never by content', () => {
    const research = { ...begin, kind: 'research' };
    const document = { name: 'plan.md', size: 1, updatedAt: at };
    expect(
      checkBeginSchema.safeParse({ ...research, documents: [{ ...document, content: 'x' }] })
        .success,
    ).toBe(false);
    expect(
      checkBeginSchema.safeParse({ ...research, documents: [{ ...document, name: '../a.md' }] })
        .success,
    ).toBe(false);
  });

  it('requires the markdown of a research report, and not more than 200 000 characters (D9, D12)', () => {
    expect(researchReportContentSchema.parse(research)).toEqual(research);
    const { markdown: _dropped, ...without } = research;
    expect(researchReportContentSchema.safeParse(without).success).toBe(false);
    expect(researchReportContentSchema.safeParse({ ...research, markdown: '' }).success).toBe(
      false,
    );
    expect(
      researchReportContentSchema.safeParse({
        ...research,
        markdown: 'x'.repeat(RESEARCH_MARKDOWN_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('gives a research report no verdict and no readiness (D9)', () => {
    expect(researchReportContentSchema.safeParse({ ...research, verdict: 'current' }).success).toBe(
      false,
    );
    expect(researchReportContentSchema.safeParse({ ...research, readiness: 'ready' }).success).toBe(
      false,
    );
  });

  it('stores a research report with the size and hash of its markdown, an actuality report with a verdict', () => {
    const meta = { bytes: 11, hash: '0123456789abcdef' };
    expect(checkReportSchema.safeParse({ ...storedReport, markdown: meta }).success).toBe(true);
    expect(checkReportSchema.safeParse({ ...storedReport, verdict: 'current' }).success).toBe(true);
    // One of the two, not both and not neither.
    expect(checkReportSchema.safeParse(storedReport).success).toBe(false);
    expect(
      checkReportSchema.safeParse({ ...storedReport, verdict: 'current', markdown: meta }).success,
    ).toBe(false);
    expect(checkReportSchema.safeParse({ ...storedReport, markdown: 'text' }).success).toBe(false);
  });

  describe('recommendation targets (D4)', () => {
    const recommendation = { id: 'r1', findings: [], text: 'Do it.' };
    const parse = (targets: unknown) =>
      recommendationSchema.safeParse({ ...recommendation, targets });

    it('describes the task, a document or a file of the project', () => {
      const targets = [
        { kind: 'task' },
        { kind: 'document', name: 'plan.md' },
        { kind: 'file', ref: 'src/core/model/history.ts' },
      ];
      expect(recommendationSchema.parse({ ...recommendation, targets }).targets).toEqual(targets);
      expect(recommendationSchema.parse(recommendation)).not.toHaveProperty('targets');
    });

    it('refuses a file outside the project as an evidence of kind file is checked (INVARIANT)', () => {
      expect(parse([{ kind: 'file', ref: '../secret.txt' }]).success).toBe(false);
      expect(parse([{ kind: 'file', ref: 'src/../../secret.txt' }]).success).toBe(false);
      expect(parse([{ kind: 'file', ref: '/etc/passwd' }]).success).toBe(false);
      expect(parse([{ kind: 'file', ref: 'a\\..\\b' }]).success).toBe(false);
      expect(parse([{ kind: 'file', ref: 'a\0b' }]).success).toBe(false);
      expect(parse([{ kind: 'file', ref: 'src/a..b.ts' }]).success).toBe(true);
    });

    it('refuses an unsafe document name and an unknown kind', () => {
      expect(parse([{ kind: 'document', name: '../a.md' }]).success).toBe(false);
      expect(parse([{ kind: 'document', name: 'task.md' }]).success).toBe(false);
      expect(parse([{ kind: 'commit', ref: 'abc1234' }]).success).toBe(false);
    });
  });
});
