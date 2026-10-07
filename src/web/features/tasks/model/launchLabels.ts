import type { ResumeBlocked } from './claudeLaunch';

/** Every word of the dialog that starts Claude Code (T38), in one place. */
export const LAUNCH_LABELS = {
  title: (taskId: string) => `Start Claude Code on ${taskId}`,
  model: {
    label: 'Model',
    hint: 'The model Claude Code runs with. Its default is the model set in Claude Code itself.',
    default: 'Claude Code default',
    other: 'Another model…',
    name: 'Model name',
    nameHint: 'An alias, or a full name that starts with claude-, like claude-sonnet-4-6.',
    invalid: 'This is not a model name: use lowercase letters, digits, dots and dashes.',
  },
  language: {
    label: 'Report language (a setting of this task)',
    hint: 'A setting of this task, not of this start: a change is saved to the AI settings of the task before Claude Code starts.',
    reading: 'Reading the language in effect…',
  },
  session: {
    label: 'Session',
    new: 'New session',
    resume: 'Continue the last session (Resume)',
    blocked: {
      noSession: 'Resume needs a session of an earlier run, and this task has no session yet.',
      working: 'Resume is not possible during a run.',
      notSupported: 'The runner cannot continue a session yet; a new session is started.',
    } satisfies Record<ResumeBlocked, string>,
  },
  working: 'Claude Code is working on this task. Wait until the run ends before you start another.',
  start: 'Start',
  starting: 'Starting…',
  cancel: 'Cancel',
  retry: 'Try again',
  started: (taskId: string) =>
    `Claude Code is starting on ${taskId} in the terminal where ` +
    '`local-project-board claude --wait` runs.',
} as const;
