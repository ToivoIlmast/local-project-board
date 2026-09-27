import type {
  BoardWorkflowKey,
  WorkflowKey,
  WorkflowSettings,
  WorkflowSource,
} from '../../../../contract/v1/index';

/**
 * The words for every AI workflow setting, in one place: the page for the board and its
 * columns uses them, and so will the page for a task. A setting added to the model without a
 * text does not compile.
 */
export const WORKFLOW_LABELS: Record<WorkflowKey, { label: string; description: string }> = {
  editCode: {
    label: 'Edit code',
    description: 'The agent may change the files of the project; otherwise it only analyses.',
  },
  branch: {
    label: 'Work in a branch',
    description: 'Work in a separate branch of its own and record it on the task.',
  },
  checks: {
    label: 'Run the checks',
    description: 'Run the checks of the project before finishing.',
  },
  commit: {
    label: 'Commit',
    description: 'Commit the work in the branch of the task.',
  },
  push: {
    label: 'Push',
    description: 'Push the branch.',
  },
  report: {
    label: 'Write a report',
    description: 'Leave the result of the work in the report of the task.',
  },
  startStatus: {
    label: 'Status when work starts',
    description: 'The status a task moves to when the agent starts on it.',
  },
  finishStatus: {
    label: 'Status when work is finished',
    description:
      'The status a task moves to when the agent is done; otherwise it waits for review.',
  },
  baseBranch: {
    label: 'Base branch',
    description: "The branch the work is based on. Empty means the repository's default branch.",
  },
  checkCommand: {
    label: 'Check command',
    description: 'The command that runs the checks. Empty is the own pipeline of the project.',
  },
  reportLanguage: {
    label: 'Report language',
    description: 'The language the agent writes the report in. Empty means English (the default).',
  },
};

/**
 * Where the value in effect comes from, for the sentence "In effect: on, from …". A column is
 * "this column" on the page of the columns, and it is named on the page of a task, where there
 * is more than one column to mean.
 */
export function sourceLabel(source: WorkflowSource, column?: string): string {
  switch (source) {
    case 'default':
      return 'the default';
    case 'board':
      return 'the board';
    case 'status':
      return column === undefined ? 'this column' : `the column ${column}`;
    case 'task':
      return 'this task';
  }
}

/** Why a muted setting is muted; it is said in words, not only by how it is drawn. */
export const INACTIVE_NOTE = `Not used while “${WORKFLOW_LABELS.editCode.label}” is off.`;

export const onOff = (value: boolean): 'on' | 'off' => (value ? 'on' : 'off');

/** What a board-only setting that has no value of its own means, in words. */
const NO_VALUE: Record<BoardWorkflowKey, string> = {
  startStatus: 'not changed',
  finishStatus: 'not changed',
  baseBranch: "the repository's default branch",
  checkCommand: 'the pipeline of the project',
  reportLanguage: 'English',
};

/** The value of a board-only setting as a person reads it: `null` is a meaning, not a blank. */
export function boardValueText(key: BoardWorkflowKey, settings: WorkflowSettings): string {
  return settings[key] ?? NO_VALUE[key];
}
