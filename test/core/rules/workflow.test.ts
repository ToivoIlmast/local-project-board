import {
  DEFAULT_WORKFLOW,
  WORKFLOW_KEYS,
  defaultWorkflow,
  findWorkflowIssues,
  resolveWorkflow,
  type WorkflowKey,
  type WorkflowSettings,
} from '../../../src/core/index.js';

const statuses = ['backlog', 'todo', 'in-progress', 'done'];

describe('DEFAULT_WORKFLOW', () => {
  it('is what the board decided every agent does unless told otherwise', () => {
    expect(DEFAULT_WORKFLOW).toEqual({
      editCode: true,
      branch: true,
      checks: true,
      commit: true,
      push: false,
      report: true,
      startStatus: 'in-progress',
      finishStatus: null,
      baseBranch: null,
      checkCommand: null,
    });
  });

  it('has a value for every key and nothing else', () => {
    expect(Object.keys(DEFAULT_WORKFLOW).sort()).toEqual([...WORKFLOW_KEYS].sort());
  });
});

describe('defaultWorkflow', () => {
  it('starts work in `in-progress` when the board has that status', () => {
    expect(defaultWorkflow(statuses).startStatus).toBe('in-progress');
  });

  it('does not invent a status the board does not have', () => {
    expect(defaultWorkflow(['todo', 'done']).startStatus).toBeNull();
  });

  it('changes nothing else', () => {
    expect({ ...defaultWorkflow(['todo']), startStatus: null }).toEqual({
      ...DEFAULT_WORKFLOW,
      startStatus: null,
    });
  });
});

describe('resolveWorkflow', () => {
  const defaults = defaultWorkflow(statuses);
  const everySource = (source: string): Record<WorkflowKey, string> =>
    Object.fromEntries(WORKFLOW_KEYS.map((key) => [key, source])) as Record<WorkflowKey, string>;

  it('gives the defaults, all from `default`, when nothing is overridden', () => {
    const effective = resolveWorkflow(defaults, {}, undefined, undefined);
    expect(effective.values).toEqual(defaults);
    expect(effective.sources).toEqual(everySource('default'));
    expect(effective.inactive).toEqual([]);
  });

  it('treats empty override objects like missing ones', () => {
    expect(resolveWorkflow(defaults, {}, {}, {})).toEqual(
      resolveWorkflow(defaults, {}, undefined, undefined),
    );
  });

  describe('one override on each level', () => {
    it.each([
      ['board', { board: { push: true }, status: undefined, task: undefined }],
      ['status', { board: {}, status: { push: true }, task: undefined }],
      ['task', { board: {}, status: undefined, task: { push: true } }],
    ] as const)('%s wins over the default and is named as the source', (source, levels) => {
      const effective = resolveWorkflow(defaults, levels.board, levels.status, levels.task);
      expect(effective.values.push).toBe(true);
      expect(effective.sources.push).toBe(source);
      // Every other key is untouched.
      expect({ ...effective.values, push: false }).toEqual(defaults);
      expect(effective.sources.branch).toBe('default');
    });
  });

  describe('the last level that sets a key wins: task > status > board > default', () => {
    // Each level sets a different value, so swapping any two levels changes the answer.
    it('task overrides status overrides board', () => {
      const effective = resolveWorkflow(
        { ...defaults, commit: true },
        { commit: false },
        { commit: true },
        { commit: false },
      );
      expect(effective.values.commit).toBe(false);
      expect(effective.sources.commit).toBe('task');
    });

    it('status overrides board', () => {
      const effective = resolveWorkflow(defaults, { commit: false }, { commit: true }, {});
      expect(effective.values.commit).toBe(true);
      expect(effective.sources.commit).toBe('status');
    });

    it('board overrides the default', () => {
      const effective = resolveWorkflow(defaults, { push: true }, {}, {});
      expect(effective.values.push).toBe(true);
      expect(effective.sources.push).toBe('board');
    });

    it('is decided per key, not per level', () => {
      const effective = resolveWorkflow(
        defaults,
        { push: true, checks: false, report: false },
        { checks: true, commit: false },
        { commit: true },
      );
      expect(effective.values).toMatchObject({
        push: true,
        checks: true,
        report: false,
        commit: true,
      });
      expect(effective.sources).toMatchObject({
        push: 'board',
        checks: 'status',
        report: 'board',
        commit: 'task',
        branch: 'default',
      });
    });

    it('lets a lower level override a higher level that set the opposite of the default', () => {
      // board turns push on, the task turns it back off: the default value must not "win" by accident.
      const effective = resolveWorkflow(defaults, { push: true }, undefined, { push: false });
      expect(effective.values.push).toBe(false);
      expect(effective.sources.push).toBe('task');
    });
  });

  describe('keys that only the board sets', () => {
    it('takes them from the board and names the board as the source', () => {
      const effective = resolveWorkflow(
        defaults,
        {
          startStatus: 'todo',
          finishStatus: 'done',
          baseBranch: 'develop',
          checkCommand: 'npm test',
        },
        undefined,
        undefined,
      );
      expect(effective.values).toMatchObject({
        startStatus: 'todo',
        finishStatus: 'done',
        baseBranch: 'develop',
        checkCommand: 'npm test',
      });
      expect(effective.sources).toMatchObject({
        startStatus: 'board',
        finishStatus: 'board',
        baseBranch: 'board',
        checkCommand: 'board',
      });
    });

    it('lets the board switch a value off with an explicit null', () => {
      const effective = resolveWorkflow(defaults, { startStatus: null }, undefined, undefined);
      expect(effective.values.startStatus).toBeNull();
      expect(effective.sources.startStatus).toBe('board');
    });
  });

  describe('dependent settings when the agent may not edit code', () => {
    it('keeps their values as they are and marks them inactive', () => {
      const effective = resolveWorkflow(
        defaults,
        { push: true },
        { editCode: false },
        { commit: false },
      );
      expect(effective.values).toMatchObject({
        editCode: false,
        branch: true,
        checks: true,
        commit: false,
        push: true,
      });
      expect(effective.inactive).toEqual(['branch', 'checks', 'commit', 'push']);
    });

    it('does not mark `report` inactive: the result still goes into a document', () => {
      const effective = resolveWorkflow(defaults, {}, { editCode: false }, undefined);
      expect(effective.inactive).not.toContain('report');
      expect(effective.inactive).not.toContain('editCode');
    });

    it('marks nothing inactive when editCode is on', () => {
      expect(resolveWorkflow(defaults, {}, undefined, { editCode: true }).inactive).toEqual([]);
    });

    it('follows the level that set editCode', () => {
      const off = resolveWorkflow(defaults, { editCode: false }, {}, { editCode: true });
      expect(off.inactive).toEqual([]);
      const on = resolveWorkflow(defaults, { editCode: true }, {}, { editCode: false });
      expect(on.inactive).toHaveLength(4);
    });
  });

  describe('purity', () => {
    it('does not change what it is given and does not return it', () => {
      const board = Object.freeze({ push: true });
      const status = Object.freeze({ checks: false });
      const task = Object.freeze({ commit: false });
      const frozenDefaults = Object.freeze({ ...defaults });

      const effective = resolveWorkflow(frozenDefaults, board, status, task);

      expect(effective.values).not.toBe(frozenDefaults);
      expect(frozenDefaults).toEqual(defaults);
      expect(board).toEqual({ push: true });
    });

    it('gives the same answer twice', () => {
      const args = [defaults, { push: true }, { checks: false }, { commit: false }] as const;
      expect(resolveWorkflow(...args)).toEqual(resolveWorkflow(...args));
    });

    it('ignores a key it does not know', () => {
      const foreign = { push: true, sourceEdits: true } as unknown as { push: boolean };
      const effective = resolveWorkflow(defaults, foreign, undefined, undefined);
      expect(Object.keys(effective.values).sort()).toEqual([...WORKFLOW_KEYS].sort());
    });
  });

  it('describes a source for exactly the keys it has a value for', () => {
    const effective = resolveWorkflow(defaults, {}, undefined, undefined);
    const values: WorkflowSettings = effective.values;
    expect(Object.keys(effective.sources).sort()).toEqual(Object.keys(values).sort());
  });
});

describe('findWorkflowIssues', () => {
  const empty = { board: {}, statuses: {} };

  it('finds nothing wrong with empty overrides', () => {
    expect(findWorkflowIssues(empty, statuses)).toEqual([]);
  });

  it('finds nothing wrong with configured statuses', () => {
    const workflow = {
      board: { startStatus: 'todo', finishStatus: 'done' },
      statuses: { backlog: { editCode: false }, done: {} },
    };
    expect(findWorkflowIssues(workflow, statuses)).toEqual([]);
  });

  it('names a column whose status is not configured', () => {
    const issues = findWorkflowIssues(
      { board: {}, statuses: { review: { editCode: false }, todo: {} } },
      statuses,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('statuses.review');
    expect(issues[0]).toContain('backlog, todo, in-progress, done');
  });

  it('reports every unknown column, in the order they were written', () => {
    const issues = findWorkflowIssues(
      { board: {}, statuses: { qa: {}, todo: {}, review: {} } },
      statuses,
    );
    expect(issues.map((issue) => /statuses\.(\w+)/.exec(issue)?.[1])).toEqual(['qa', 'review']);
  });

  it.each(['startStatus', 'finishStatus'] as const)(
    'names a %s that is not a configured status',
    (key) => {
      const issues = findWorkflowIssues({ board: { [key]: 'review' }, statuses: {} }, statuses);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain(`board.${key}`);
    },
  );

  it('accepts a null start or finish status: it means "do not change the status"', () => {
    expect(
      findWorkflowIssues({ board: { startStatus: null, finishStatus: null }, statuses: {} }, []),
    ).toEqual([]);
  });
});
