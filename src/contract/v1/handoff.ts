import type { DocumentMeta } from '../../core/model/document.js';
import type { Task } from '../../core/model/task.js';
import type {
  BoardWorkflowKey,
  EffectiveWorkflow,
  WorkflowKey,
  WorkflowSettings,
  WorkflowSource,
} from '../../core/model/workflow.js';
import { taskBranchName } from '../../core/rules/branch.js';
import { API_BASE_PATH } from './routes.js';

/** What the steps need to know about the task besides the settings. */
export interface WorkflowFacts {
  taskId: string;
  /** The status the task is in now: it is the column that a `status` source refers to. */
  status: string;
  /** The branch to work in: the one the task records, or the one its title gives. */
  branch: string;
}

/** One numbered step; `key` is the setting that decides it, and null for a rule that is not one. */
export interface WorkflowStep {
  key: WorkflowKey | null;
  text: string;
}

/**
 * The settings that are not steps of their own but refine another one: the branch that work is
 * based on is part of "work in a branch", the command is part of "run the checks". A setting
 * that this table and `STEPS` do not both know is a type error, so a setting cannot be added to
 * the model and be left out of the text (ADR-0028).
 */
export const WORKFLOW_STEP_PARAMETERS = {
  branch: 'baseBranch',
  checks: 'checkCommand',
} as const satisfies Partial<Record<WorkflowKey, BoardWorkflowKey>>;

type Parameters = typeof WORKFLOW_STEP_PARAMETERS;
type ParameterKey = Parameters[keyof Parameters];
type StepKey = Exclude<WorkflowKey, ParameterKey>;

interface StepContext<K extends StepKey> {
  value: WorkflowSettings[K];
  /** The setting that refines this one, or null when nothing does. */
  parameter: K extends keyof Parameters ? WorkflowSettings[Parameters[K]] : null;
  /** The setting cannot matter: the agent may not edit code. */
  inactive: boolean;
  facts: WorkflowFacts;
}

/** The whole text of a setting, for every value it can have. Nothing else in the board writes it. */
type Renderers = { [K in StepKey]: (context: StepContext<K>) => string };

const tasks = (facts: WorkflowFacts): string => `${API_BASE_PATH}/tasks/${facts.taskId}`;
const patch = (facts: WorkflowFacts, body: Record<string, string>): string =>
  `\`PATCH ${tasks(facts)}\` with \`${JSON.stringify(body)}\``;

/**
 * The order of the keys is the order of the steps. Every setting says what to do when it is on
 * and what not to do when it is off; while `editCode` is off, the ones that depend on it say
 * that they do not apply, whatever their value is.
 */
const STEPS: Renderers = {
  startStatus: ({ value, facts }) =>
    value === null
      ? 'Leave the status of the task as it is when you start.'
      : `Move the task to \`${value}\` before you start: ${patch(facts, { status: value })}.`,

  editCode: ({ value, facts }) =>
    value
      ? 'You may change the files of the project.'
      : 'Do not change any file of the project: analyse and plan only. What you find belongs ' +
        `in the documents of this task (\`PUT ${tasks(facts)}/documents/<name>.md\`).`,

  branch: ({ value, parameter, inactive, facts }) => {
    if (inactive) {
      return 'Do not create a branch: without changes to the code there is nothing to put in one.';
    }
    if (!value) return 'Do not create a branch: stay on the branch that is checked out now.';
    const base = parameter === null ? 'the main branch of the repository' : `\`${parameter}\``;
    return (
      `Work in a branch of your own, \`${facts.branch}\`, based on ${base}: create it if it ` +
      'does not exist yet, otherwise switch to it. ' +
      `Record it in the task: ${patch(facts, { branch: facts.branch })}. ` +
      'Never commit to the branch it is based on.'
    );
  },

  checks: ({ value, parameter, inactive }) => {
    if (inactive) {
      return (
        'Do not run the checks of the project: ' +
        'without changes to the code there is nothing to check.'
      );
    }
    if (!value) return 'Do not run the checks of the project.';
    return parameter === null
      ? 'Before you finish, run the checks of the project — its full pipeline, as its README ' +
          'or CLAUDE.md describes it — and fix what fails.'
      : `Before you finish, run the checks of the project with \`${parameter}\` and fix what fails.`;
  },

  commit: ({ value, inactive, facts }) => {
    if (inactive) return 'Do not commit: there are no changes to commit.';
    return value
      ? `Commit your work; start the message with the task id, like \`${facts.taskId}: what changed\`.`
      : 'Do not commit: leave your changes in the working tree.';
  },

  push: ({ value, inactive }) => {
    if (inactive) return 'Do not push: there is nothing to push.';
    return value ? 'Push your commits to the remote.' : 'Do not push: nothing leaves this machine.';
  },

  report: ({ value, facts }) =>
    value
      ? 'Write what you did, what you checked and what is left into the document `report.md` ' +
        `of this task: \`PUT ${tasks(facts)}/documents/report.md\`.`
      : 'Do not write a `report.md` for this task.',

  finishStatus: ({ value, facts }) =>
    value === null
      ? 'When you are done, leave the status of the task as it is: it waits for the review.'
      : `When you are done, move the task to \`${value}\`: ${patch(facts, { status: value })}.`,
};

/** What an agent never does, whatever is configured: these are not settings (ADR-0028). */
const RULES: readonly string[] = [
  'Never merge a branch, into any branch.',
  'Never write the session token into a file of the project, a task, a document or a report.',
  'When you are done, stop and wait for the review; do not start another task.',
];

const STEP_KEYS = Object.keys(STEPS) as StepKey[];

function sourceLabel(source: WorkflowSource, facts: WorkflowFacts): string {
  switch (source) {
    case 'default':
      return 'default';
    case 'board':
      return 'board';
    case 'status':
      return `column "${facts.status}"`;
    case 'task':
      return 'this task';
  }
}

/**
 * The steps an agent takes on one task, one per setting and one text for each of its values.
 * The values and their sources are the ones `resolveWorkflow` computed; nothing is worked out
 * here (ADR-0028). Pure, and the same for the same input.
 */
export function workflowSteps(effective: EffectiveWorkflow, facts: WorkflowFacts): WorkflowStep[] {
  const { values, sources, inactive } = effective;
  const parameters: Partial<Record<StepKey, ParameterKey>> = WORKFLOW_STEP_PARAMETERS;

  const steps = STEP_KEYS.map((key): WorkflowStep => {
    const parameter = parameters[key];
    const off = (inactive as readonly WorkflowKey[]).includes(key);
    // Each renderer is typed for its own setting; here they are called by key, so the type of
    // the context is the union that they accept between them.
    const render = STEPS[key] as (context: StepContext<StepKey>) => string;
    const text = render({
      value: values[key],
      parameter: parameter === undefined ? null : values[parameter],
      inactive: off,
      facts,
    } as StepContext<StepKey>);

    // Where the values came from; a refining setting is named only if the text used it.
    const origin = [`source: ${sourceLabel(sources[key], facts)}`];
    if (parameter !== undefined && values[key] === true && !off) {
      origin.push(`${parameter}: ${sourceLabel(sources[parameter], facts)}`);
    }
    if (off) origin.push('inactive: editCode is off');
    return { key, text: `${text} _(${origin.join('; ')})_` };
  });
  return [...steps, ...RULES.map((text): WorkflowStep => ({ key: null, text }))];
}

/** The steps as a numbered markdown list, one line each. */
export function renderWorkflowSteps(effective: EffectiveWorkflow, facts: WorkflowFacts): string {
  return `${workflowSteps(effective, facts)
    .map((step, index) => `${index + 1}. ${step.text}`)
    .join('\n')}\n`;
}

export interface HandoffOptions {
  task: Task;
  documents: readonly DocumentMeta[];
  /** What `resolveWorkflow` computed for this task; the handoff never works it out itself. */
  effective: EffectiveWorkflow;
  /** The general instructions for the API, as `generateInstructions` made them — without a token. */
  instructions: string;
}

/**
 * Everything an agent needs to work on one task, as one markdown text: the task, what is
 * attached to it, how to work on it under the settings that apply to it, and the instructions
 * for the API. It says nothing about the workflow that `renderWorkflowSteps` does not, and
 * nothing that depends on the moment: the same state of the board gives the same text.
 */
export function generateHandoff({
  task,
  documents,
  effective,
  instructions,
}: HandoffOptions): string {
  const facts: WorkflowFacts = {
    taskId: task.id,
    status: task.status,
    branch: task.branch ?? taskBranchName(task.id, task.title),
  };
  const lines = [`# Task ${task.id}: ${task.title}`, '', `- Status: \`${task.status}\``];
  if (task.labels.length > 0) {
    lines.push(`- Labels: ${task.labels.map((label) => `\`${label}\``).join(', ')}`);
  }
  if (task.branch !== undefined) lines.push(`- Branch: \`${task.branch}\``);

  lines.push('', '## Description', '');
  lines.push(task.body.trim() === '' ? 'This task has no description.' : task.body.trimEnd());

  lines.push('', '## Documents', '');
  if (documents.length === 0) {
    lines.push('No documents are attached to this task yet.');
  } else {
    const byName = [...documents].sort((a, b) => Number(a.name > b.name) - Number(a.name < b.name));
    lines.push(...byName.map((document) => `- \`${document.name}\` (${document.size} bytes)`));
    lines.push('', `Read one with \`GET ${tasks(facts)}/documents/<name>\`.`);
  }

  lines.push(
    '',
    '## How to work on this task',
    '',
    renderWorkflowSteps(effective, facts).trimEnd(),
    '',
    '---',
    '',
  );
  return `${lines.join('\n')}\n${instructions.trimEnd()}\n`;
}
