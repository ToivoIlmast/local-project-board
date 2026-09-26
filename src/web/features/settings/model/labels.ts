import type { WorkflowKey } from '../../../../contract/v1/index';

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
    description: 'The branch the work is based on. Empty is the main branch of the repository.',
  },
  checkCommand: {
    label: 'Check command',
    description: 'The command that runs the checks. Empty is the own pipeline of the project.',
  },
};

/** Where the value in effect comes from, for the sentence "In effect: on, from …". */
export const SOURCE_LABELS = {
  default: 'the default',
  board: 'the board',
  status: 'this column',
} as const;

/** Why a muted setting is muted; it is said in words, not only by how it is drawn. */
export const INACTIVE_NOTE = `Not used while “${WORKFLOW_LABELS.editCode.label}” is off.`;

export const onOff = (value: boolean): 'on' | 'off' => (value ? 'on' : 'off');
