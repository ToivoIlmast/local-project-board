import {
  API_BASE_PATH,
  WORKFLOW_STEP_PARAMETERS,
  generateHandoff,
  generateInstructions,
  renderWorkflowSteps,
  workflowSteps,
  type WorkflowFacts,
} from '../../src/contract/v1/index.js';
import {
  BOARD_WORKFLOW_KEYS,
  WORKFLOW_FLAGS,
  WORKFLOW_KEYS,
  defaultWorkflow,
  resolveWorkflow,
  type BoardWorkflowOverrides,
  type DocumentMeta,
  type EffectiveWorkflow,
  type Task,
  type WorkflowFlagOverrides,
  type WorkflowFlag,
} from '../../src/core/index.js';

const STATUSES = ['backlog', 'todo', 'in-progress', 'done'];

const FACTS: WorkflowFacts = {
  taskId: 'T13',
  status: 'todo',
  branch: 'task/T13-ai-workflow-model',
};

interface Levels {
  board?: BoardWorkflowOverrides;
  status?: WorkflowFlagOverrides;
  task?: WorkflowFlagOverrides;
}

/** What the API would compute for a task in `todo`: the one function that decides (ADR-0028). */
const effective = ({ board = {}, status, task }: Levels = {}): EffectiveWorkflow =>
  resolveWorkflow(defaultWorkflow(STATUSES), board, status, task);

/** The numbered lines of a rendering: one per step, in order. */
const lines = (text: string): string[] => text.split('\n').filter((line) => /^\d+\. /.test(line));

const stepFor = (levels: Levels, key: string): string => {
  const step = workflowSteps(effective(levels), FACTS).find((candidate) => candidate.key === key);
  if (!step) throw new Error(`no step for ${key}`);
  return step.text;
};

describe('renderWorkflowSteps', () => {
  describe('one step for every setting and every value (INVARIANT)', () => {
    const stepKeys = (levels: Levels = {}): string[] =>
      workflowSteps(effective(levels), FACTS)
        .map((step) => step.key)
        .filter((key): key is NonNullable<typeof key> => key !== null);

    it('covers every key of the model: a step of its own, or the step it is a parameter of', () => {
      const parameters = Object.values(WORKFLOW_STEP_PARAMETERS) as string[];
      // A setting added to the model without a text here fails this, and so does a step for a
      // setting the model does not have.
      expect([...stepKeys(), ...parameters].sort()).toEqual([...WORKFLOW_KEYS].sort());
      // The parameters are the board-only settings that only refine another step.
      for (const parameter of parameters) {
        expect(BOARD_WORKFLOW_KEYS as readonly string[]).toContain(parameter);
      }
    });

    it('has exactly one step per key, whatever the values are', () => {
      const variants: Levels[] = [
        {},
        { task: { editCode: false } },
        {
          board: {
            startStatus: null,
            finishStatus: 'done',
            baseBranch: 'main',
            checkCommand: 'npm test',
          },
        },
        { task: { branch: false, checks: false, commit: false, push: true, report: false } },
      ];
      for (const levels of variants) {
        const keys = stepKeys(levels);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys.sort()).toEqual(stepKeys().sort());
      }
    });

    it.each(WORKFLOW_FLAGS)('says something different when %s is on and when it is off', (flag) => {
      const on = stepFor({ task: { [flag]: true } }, flag);
      const off = stepFor({ task: { [flag]: false } }, flag);

      expect(on).not.toBe(off);
    });

    it.each(['startStatus', 'finishStatus'] as const)(
      'says something different when %s is a status and when it is left alone',
      (key) => {
        const set = stepFor({ board: { [key]: 'done' } }, key);
        const none = stepFor({ board: { [key]: null } }, key);

        expect(set).not.toBe(none);
        expect(set).toContain('`done`');
        expect(none).not.toContain('`done`');
      },
    );

    it('numbers the steps in the order they are taken', () => {
      const steps = lines(renderWorkflowSteps(effective(), FACTS));

      expect(steps.map((step) => Number(/^(\d+)\./.exec(step)?.[1]))).toEqual(
        steps.map((_step, index) => index + 1),
      );
    });
  });

  describe('a switch on any of the three levels changes exactly its step (INVARIANT)', () => {
    const levelsOf = (
      level: 'board' | 'status' | 'task',
      overrides: WorkflowFlagOverrides,
    ): Levels => (level === 'board' ? { board: overrides } : { [level]: overrides });

    // `editCode` is the one setting that reaches other steps, and has its own tests below.
    const independent = WORKFLOW_FLAGS.filter((flag) => flag !== 'editCode');

    for (const level of ['board', 'status', 'task'] as const) {
      it.each(independent)(
        `toggling ${level}.%s changes only the step of %s`,
        (flag: WorkflowFlag) => {
          const before = workflowSteps(effective(levelsOf(level, { [flag]: true })), FACTS);
          const after = workflowSteps(effective(levelsOf(level, { [flag]: false })), FACTS);

          const changed = before
            .filter((step, index) => step.text !== after[index]?.text)
            .map((step) => step.key);
          expect(changed).toEqual([flag]);
        },
      );
    }

    it('changes the text of a step only through the value that reaches it, not through its neighbours', () => {
      const base = workflowSteps(effective(), FACTS);
      const other = workflowSteps(effective({ task: { report: false } }), FACTS);

      expect(base.filter((step) => step.key !== 'report')).toEqual(
        other.filter((step) => step.key !== 'report'),
      );
    });
  });

  describe('editCode: false', () => {
    const off: Levels = { task: { editCode: false } };

    it('forbids changing the files of the project and points to the documents of the task', () => {
      const step = stepFor(off, 'editCode');

      expect(step).toMatch(/^Do not change any file of the project/);
      expect(step).toContain(`PUT ${API_BASE_PATH}/tasks/T13/documents/<name>.md`);
    });

    it.each(['branch', 'checks', 'commit', 'push'])(
      'turns %s into an explicit prohibition even when it is switched on',
      (key) => {
        const configuredOn = stepFor({ task: { editCode: false, [key]: true } }, key);

        expect(configuredOn).toMatch(/^Do not /);
        expect(configuredOn).toContain('inactive: editCode is off');
        // The same text as when it is switched off: the value has no say while editCode is off.
        expect(configuredOn).toBe(stepFor({ task: { editCode: false, [key]: false } }, key));
      },
    );

    it('leaves nothing that asks the agent to create a branch, run checks, commit or push', () => {
      const text = renderWorkflowSteps(
        effective({ board: { checkCommand: 'npm test' }, ...off }),
        FACTS,
      );

      expect(text).not.toMatch(/Push your|Commit your|Work in a branch|Before you finish, run/);
      expect(text).not.toContain('npm test');
      expect(text).not.toContain('task/T13-ai-workflow-model');
      expect(text).not.toContain('"branch"');
    });

    it('does not touch the report or the statuses: they still make sense without code', () => {
      const on = workflowSteps(effective(), FACTS);
      const off_ = workflowSteps(effective(off), FACTS);
      const same = (key: string) => on.find((s) => s.key === key)?.text;
      const same_ = (key: string) => off_.find((s) => s.key === key)?.text;

      for (const key of ['startStatus', 'report', 'finishStatus'])
        expect(same_(key)).toBe(same(key));
    });

    it('gives the settings back exactly as configured when editCode is switched on again', () => {
      const configured: Levels = { board: { push: true, checkCommand: 'npm test' } };
      const back = workflowSteps(effective({ ...configured, task: { editCode: true } }), FACTS);
      const never = workflowSteps(effective(configured), FACTS);

      // Only `editCode` itself differs: it is now set on the task, and says so.
      expect(back.filter((step) => step.key !== 'editCode')).toEqual(
        never.filter((step) => step.key !== 'editCode'),
      );
    });
  });

  describe('what each setting says', () => {
    it('branch: on names the branch, its base and the PATCH that records it', () => {
      const step = stepFor({ board: { baseBranch: 'develop' } }, 'branch');

      expect(step).toContain('`task/T13-ai-workflow-model`');
      expect(step).toContain('based on `develop`');
      expect(step).toContain(`PATCH ${API_BASE_PATH}/tasks/T13`);
      expect(step).toContain('{"branch":"task/T13-ai-workflow-model"}');
      expect(step).toMatch(/Never commit to the branch it is based on/);
    });

    it('branch: without a base branch it is based on the main branch of the repository', () => {
      expect(stepFor({}, 'branch')).toContain('based on the main branch of the repository');
    });

    it('branch: off forbids it and says where to stay', () => {
      const step = stepFor({ task: { branch: false } }, 'branch');

      expect(step).toMatch(/^Do not create a branch/);
      expect(step).not.toContain('task/T13-ai-workflow-model');
    });

    it('checks: on runs the command of the board, or else the full pipeline of the project', () => {
      expect(stepFor({ board: { checkCommand: 'npm run verify' } }, 'checks')).toContain(
        '`npm run verify`',
      );
      expect(stepFor({}, 'checks')).toContain('full pipeline');
      expect(stepFor({}, 'checks')).not.toContain('`');
    });

    it('checks: off does not run them, and the command that is set stays out of the text', () => {
      const step = stepFor(
        { board: { checkCommand: 'npm run verify' }, task: { checks: false } },
        'checks',
      );

      expect(step).toMatch(/^Do not run/);
      expect(step).not.toContain('npm run verify');
    });

    it('commit: on asks for the task id in the message; off forbids it', () => {
      expect(stepFor({}, 'commit')).toContain('`T13: what changed`');
      expect(stepFor({ task: { commit: false } }, 'commit')).toMatch(/^Do not commit/);
    });

    it('push: is off by default, and off never turns into permission', () => {
      expect(stepFor({}, 'push')).toMatch(/^Do not push/);
      expect(stepFor({ task: { push: true } }, 'push')).toMatch(/^Push your commits/);
      expect(stepFor({ task: { push: false } }, 'push')).toMatch(/^Do not push/);
    });

    it('report: on names the document; off forbids writing it', () => {
      expect(stepFor({}, 'report')).toContain(`PUT ${API_BASE_PATH}/tasks/T13/documents/report.md`);
      expect(stepFor({ task: { report: false } }, 'report')).toMatch(/^Do not write a `report.md`/);
    });

    it('startStatus and finishStatus: a status is moved to with PATCH, null leaves it alone', () => {
      expect(stepFor({}, 'startStatus')).toContain('{"status":"in-progress"}');
      expect(stepFor({ board: { startStatus: null } }, 'startStatus')).toMatch(/^Leave the status/);
      expect(stepFor({ board: { finishStatus: 'done' } }, 'finishStatus')).toContain(
        '{"status":"done"}',
      );
      expect(stepFor({}, 'finishStatus')).toMatch(/^When you are done, leave the status/);
    });
  });

  describe('where each setting comes from', () => {
    const sourceOf = (levels: Levels, key: string): string =>
      /_\(([^)]*)\)_$/.exec(stepFor(levels, key))?.[1] ?? '(none)';

    it('names the default, the board, the column and the task', () => {
      expect(sourceOf({}, 'push')).toBe('source: default');
      expect(sourceOf({ board: { push: true } }, 'push')).toBe('source: board');
      expect(sourceOf({ status: { push: true } }, 'push')).toBe('source: column "todo"');
      expect(sourceOf({ task: { push: true } }, 'push')).toBe('source: this task');
    });

    it('uses the level that won, not the one that is nearest (task > column > board > default)', () => {
      const levels: Levels = {
        board: { commit: false },
        status: { commit: true },
        task: { commit: false },
      };

      expect(sourceOf(levels, 'commit')).toBe('source: this task');
      expect(sourceOf({ ...levels, task: {} }, 'commit')).toBe('source: column "todo"');
      expect(sourceOf({ ...levels, task: {}, status: {} }, 'commit')).toBe('source: board');
      expect(sourceOf({}, 'commit')).toBe('source: default');
    });

    it('takes the source from the effective settings and never works it out itself (INVARIANT)', () => {
      const given = effective();
      const lying: EffectiveWorkflow = {
        ...given,
        sources: { ...given.sources, push: 'task' },
      };

      const step = workflowSteps(lying, FACTS).find((s) => s.key === 'push')?.text;
      expect(step).toContain('source: this task');
    });

    it('names the source of a parameter that the step used', () => {
      expect(sourceOf({ board: { baseBranch: 'develop' } }, 'branch')).toBe(
        'source: default; baseBranch: board',
      );
      expect(
        sourceOf({ status: { checks: true }, board: { checkCommand: 'npm test' } }, 'checks'),
      ).toBe('source: column "todo"; checkCommand: board');
      // A parameter that the step did not use is not mentioned.
      expect(sourceOf({ task: { checks: false } }, 'checks')).toBe('source: this task');
      expect(sourceOf({ task: { branch: false } }, 'branch')).toBe('source: this task');
    });

    it('marks a setting that is not in effect, with the source it was configured at', () => {
      expect(sourceOf({ board: { push: true }, task: { editCode: false } }, 'push')).toBe(
        'source: board; inactive: editCode is off',
      );
    });
  });

  describe('rules that are not settings', () => {
    const variants: [string, Levels][] = [
      ['the defaults', {}],
      [
        'everything on',
        {
          task: {
            editCode: true,
            branch: true,
            checks: true,
            commit: true,
            push: true,
            report: true,
          },
        },
      ],
      [
        'everything off',
        {
          task: {
            editCode: false,
            branch: false,
            checks: false,
            commit: false,
            push: false,
            report: false,
          },
        },
      ],
    ];

    it.each(variants)('are always there, whatever is configured: %s', (_name, levels) => {
      const text = renderWorkflowSteps(effective(levels), FACTS);

      expect(text).toContain('Never merge a branch');
      expect(text).toContain('Never write the session token into a file of the project');
      expect(text).toContain('stop and wait for the review');
    });

    it('are the last steps and carry no source, because no setting decides them', () => {
      const steps = workflowSteps(effective(), FACTS);
      const rules = steps.filter((step) => step.key === null);

      expect(rules).toHaveLength(3);
      expect(steps.slice(-3)).toEqual(rules);
      for (const rule of rules) expect(rule.text).not.toContain('source:');
    });
  });

  describe('three characteristic combinations', () => {
    it('everything by default', () => {
      expect(renderWorkflowSteps(effective(), FACTS)).toBe(
        [
          '1. Move the task to `in-progress` before you start: `PATCH /api/v1/tasks/T13` with `{"status":"in-progress"}`. _(source: default)_',
          '2. You may change the files of the project. _(source: default)_',
          '3. Work in a branch of your own, `task/T13-ai-workflow-model`, based on the main branch of the repository: create it if it does not exist yet, otherwise switch to it. Record it in the task: `PATCH /api/v1/tasks/T13` with `{"branch":"task/T13-ai-workflow-model"}`. Never commit to the branch it is based on. _(source: default; baseBranch: default)_',
          '4. Before you finish, run the checks of the project — its full pipeline, as its README or CLAUDE.md describes it — and fix what fails. _(source: default; checkCommand: default)_',
          '5. Commit your work; start the message with the task id, like `T13: what changed`. _(source: default)_',
          '6. Do not push: nothing leaves this machine. _(source: default)_',
          '7. Write what you did, what you checked and what is left into the document `report.md` of this task: `PUT /api/v1/tasks/T13/documents/report.md`. _(source: default)_',
          '8. When you are done, leave the status of the task as it is: it waits for the review. _(source: default)_',
          '9. Never merge a branch, into any branch.',
          '10. Never write the session token into a file of the project, a task, a document or a report.',
          '11. When you are done, stop and wait for the review; do not start another task.',
        ].join('\n') + '\n',
      );
    });

    it('editCode: false, set on the column', () => {
      expect(
        renderWorkflowSteps(
          effective({ board: { push: true }, status: { editCode: false } }),
          FACTS,
        ),
      ).toBe(
        [
          '1. Move the task to `in-progress` before you start: `PATCH /api/v1/tasks/T13` with `{"status":"in-progress"}`. _(source: default)_',
          '2. Do not change any file of the project: analyse and plan only. What you find belongs in the documents of this task (`PUT /api/v1/tasks/T13/documents/<name>.md`). _(source: column "todo")_',
          '3. Do not create a branch: without changes to the code there is nothing to put in one. _(source: default; inactive: editCode is off)_',
          '4. Do not run the checks of the project: without changes to the code there is nothing to check. _(source: default; inactive: editCode is off)_',
          '5. Do not commit: there are no changes to commit. _(source: default; inactive: editCode is off)_',
          '6. Do not push: there is nothing to push. _(source: board; inactive: editCode is off)_',
          '7. Write what you did, what you checked and what is left into the document `report.md` of this task: `PUT /api/v1/tasks/T13/documents/report.md`. _(source: default)_',
          '8. When you are done, leave the status of the task as it is: it waits for the review. _(source: default)_',
          '9. Never merge a branch, into any branch.',
          '10. Never write the session token into a file of the project, a task, a document or a report.',
          '11. When you are done, stop and wait for the review; do not start another task.',
        ].join('\n') + '\n',
      );
    });

    it('push: true and a checkCommand', () => {
      expect(
        renderWorkflowSteps(
          effective({
            board: {
              push: true,
              checkCommand: 'npm test',
              baseBranch: 'master',
              finishStatus: 'done',
            },
          }),
          FACTS,
        ),
      ).toBe(
        [
          '1. Move the task to `in-progress` before you start: `PATCH /api/v1/tasks/T13` with `{"status":"in-progress"}`. _(source: default)_',
          '2. You may change the files of the project. _(source: default)_',
          '3. Work in a branch of your own, `task/T13-ai-workflow-model`, based on `master`: create it if it does not exist yet, otherwise switch to it. Record it in the task: `PATCH /api/v1/tasks/T13` with `{"branch":"task/T13-ai-workflow-model"}`. Never commit to the branch it is based on. _(source: default; baseBranch: board)_',
          '4. Before you finish, run the checks of the project with `npm test` and fix what fails. _(source: default; checkCommand: board)_',
          '5. Commit your work; start the message with the task id, like `T13: what changed`. _(source: default)_',
          '6. Push your commits to the remote. _(source: board)_',
          '7. Write what you did, what you checked and what is left into the document `report.md` of this task: `PUT /api/v1/tasks/T13/documents/report.md`. _(source: default)_',
          '8. When you are done, move the task to `done`: `PATCH /api/v1/tasks/T13` with `{"status":"done"}`. _(source: board)_',
          '9. Never merge a branch, into any branch.',
          '10. Never write the session token into a file of the project, a task, a document or a report.',
          '11. When you are done, stop and wait for the review; do not start another task.',
        ].join('\n') + '\n',
      );
    });
  });

  it('is deterministic, and changes nothing it is given', () => {
    const given = effective({ board: { push: true }, task: { report: false } });
    const copy = structuredClone(given);
    const facts = { ...FACTS };

    const first = renderWorkflowSteps(given, facts);

    expect(renderWorkflowSteps(given, facts)).toBe(first);
    expect(given).toEqual(copy);
    expect(facts).toEqual(FACTS);
  });

  it('says nothing that could be taken for a token or another task', () => {
    const text = renderWorkflowSteps(effective({ board: { push: true } }), FACTS);

    expect(text).not.toMatch(/Bearer|Authorization/);
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
    expect(text.match(/\bT\d+\b/g)?.every((id) => id === 'T13')).toBe(true);
  });
});

describe('generateHandoff', () => {
  const INSTRUCTIONS = generateInstructions({
    baseUrl: 'http://127.0.0.1:7432',
    board: { name: 'demo', statuses: STATUSES, idPrefix: 'T' },
  });

  const task: Task = {
    id: 'T13',
    title: 'AI workflow model',
    status: 'todo',
    rank: 'a0',
    body: '## Goal\n\nOne model for the settings.\n',
    labels: ['ai-workflow', 'core'],
    createdAt: '2026-09-25T06:35:49.365Z',
    updatedAt: '2026-09-26T12:17:45.921Z',
  };
  const documents: DocumentMeta[] = [
    { taskId: 'T13', name: 'plan.md', size: 482, updatedAt: '2026-09-26T12:00:00.000Z' },
    { taskId: 'T13', name: 'notes.md', size: 12, updatedAt: '2026-09-26T12:10:00.000Z' },
  ];

  const handoff = (overrides: Partial<Parameters<typeof generateHandoff>[0]> = {}): string =>
    generateHandoff({
      task,
      documents,
      effective: effective(),
      instructions: INSTRUCTIONS,
      ...overrides,
    });

  it('starts with the task, then its body, its documents, how to work, and the API instructions', () => {
    const text = handoff();
    const at = (needle: string): number => text.indexOf(needle);

    expect(text.startsWith('# Task T13: AI workflow model\n')).toBe(true);
    const order = [
      '# Task T13: AI workflow model',
      '- Status: `todo`',
      '## Description',
      'One model for the settings.',
      '## Documents',
      '`notes.md`',
      '## How to work on this task',
      '1. Move the task',
      '# local-project-board API (v1)',
    ].map(at);
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('shows the status, the labels and the recorded branch of the task', () => {
    const text = handoff({ task: { ...task, branch: 'feat/model' } });

    expect(text).toContain('- Status: `todo`');
    expect(text).toContain('- Labels: `ai-workflow`, `core`');
    expect(text).toContain('- Branch: `feat/model`');
  });

  it('leaves out the labels and the branch that the task does not have', () => {
    const text = handoff({ task: { ...task, labels: [] } });

    expect(text).not.toContain('- Labels:');
    expect(text).not.toContain('- Branch:');
  });

  it('carries the body of the task as it is', () => {
    expect(handoff()).toContain('## Description\n\n## Goal\n\nOne model for the settings.\n\n');
  });

  it('says so when the task has no description or no documents', () => {
    const text = handoff({ task: { ...task, body: '  \n' }, documents: [] });

    expect(text).toContain('This task has no description.');
    expect(text).toContain('No documents are attached to this task yet.');
  });

  it('lists the documents by name, whatever order the storage gave them in, with the route to read one', () => {
    const text = handoff();

    expect(text.indexOf('`notes.md`')).toBeLessThan(text.indexOf('`plan.md`'));
    expect(text).toContain('`plan.md` (482 bytes)');
    expect(text).toContain(`GET ${API_BASE_PATH}/tasks/T13/documents/<name>`);
  });

  it('puts the steps of renderWorkflowSteps in, as they are and nowhere else (INVARIANT)', () => {
    const facts: WorkflowFacts = {
      taskId: 'T13',
      status: 'todo',
      branch: 'task/T13-ai-workflow-model',
    };
    const given = effective({ board: { push: true } });

    const text = handoff({ effective: given });

    expect(text).toContain(`## How to work on this task\n\n${renderWorkflowSteps(given, facts)}`);
  });

  it('is the same text apart from the steps, whatever the settings are (INVARIANT)', () => {
    const strip = (text: string): string =>
      text.replace(/## How to work on this task\n\n(\d+\. .*\n)+/, '');
    const configurations: Levels[] = [
      {},
      { task: { editCode: false } },
      { board: { push: true, checkCommand: 'npm test' }, status: { commit: false } },
    ];

    const texts = configurations.map((levels) => handoff({ effective: effective(levels) }));

    expect(new Set(texts).size).toBe(configurations.length);
    expect(new Set(texts.map(strip)).size).toBe(1);
    // No line about the workflow is written outside the steps.
    expect(strip(texts[0] ?? '')).not.toMatch(/Do not (push|commit)|Push your|Commit your/);
  });

  it('records the status of the task in the columns source of its steps', () => {
    const text = handoff({
      task: { ...task, status: 'backlog' },
      effective: resolveWorkflow(defaultWorkflow(STATUSES), {}, { editCode: false }, undefined),
    });

    expect(text).toContain('_(source: column "backlog")_');
  });

  it('works on the branch the task already has, and otherwise on the one its title gives', () => {
    expect(handoff()).toContain('{"branch":"task/T13-ai-workflow-model"}');
    expect(handoff({ task: { ...task, branch: 'feat/model' } })).toContain(
      '{"branch":"feat/model"}',
    );
    expect(handoff({ task: { ...task, branch: 'feat/model' } })).not.toContain(
      'task/T13-ai-workflow-model',
    );
  });

  it('ends with the general instructions, word for word (INVARIANT)', () => {
    const text = handoff();

    expect(text.endsWith(INSTRUCTIONS)).toBe(true);
    expect(text.split(INSTRUCTIONS).length).toBe(2);
  });

  it('is generated from what it is given: the token is not put in, and none is invented (INVARIANT)', () => {
    const text = handoff();

    expect(text).not.toMatch(/Bearer [A-Za-z0-9_-]{8,}/);
    expect(text).toContain('Authorization: Bearer <session token>');
    expect(text).toContain(`GET http://127.0.0.1:7432${API_BASE_PATH}/session`);
  });

  it('is deterministic, and is plain markdown with one final newline', () => {
    const first = handoff();

    expect(handoff()).toBe(first);
    expect(first.endsWith('\n')).toBe(true);
    expect(first.endsWith('\n\n')).toBe(false);
    expect(first).not.toContain('undefined');
  });
});
