import type { AiRun } from '../../../../contract/v1/index';
import { resumeBlocked } from './claudeLaunch';

/**
 * How the run of a task is told to the person (T39): why it ended, in words, and what can be done
 * about it. Pure, so that the table of states and kinds is read in one place.
 */

export const RUN_LABELS = {
  title: 'AI run',
  agentWord: 'reported by the agent',
  copyCommand: 'Copy command to continue by hand',
  copied: 'Command copied.',
  copyRefused: 'The page could not write to the clipboard: the browser refused.',
  resume: 'Resume',
  restart: 'Restart',
  restartTitle: (taskId: string) => `Start ${taskId} over?`,
  restartMessage: (branch: string | undefined, attempt: number) =>
    `${
      branch === undefined
        ? `The old branch is renamed to …-attempt-${attempt}`
        : `The old branch ${branch} is renamed to ${branch}-attempt-${attempt}`
    }, and the work starts over in a new session from the base branch. Nothing is deleted.`,
  starting: (taskId: string) =>
    `Claude Code is starting on ${taskId} in the terminal where ` +
    '`local-project-board claude --wait` runs.',
  failure: {
    launch: 'Claude Code could not be started.',
    exit: (code: number | undefined) =>
      code === undefined
        ? 'The session ended without a final report.'
        : `The session ended without a final report (code ${code}).`,
    lost: 'The run was lost: the runner ended without a result.',
  },
  exitWarning: (code: number) =>
    `The agent reported the run as finished, but the session exited with code ${code}.`,
} as const;

/** The failure of a run that did not end well, in words; nothing for a run that did. */
export function failureText(run: AiRun): string | undefined {
  const failure = run.failure;
  if (failure === undefined || run.state === 'finished' || run.state === 'working') {
    return undefined;
  }
  switch (failure.kind) {
    case 'launch':
      return RUN_LABELS.failure.launch;
    case 'exit':
      return RUN_LABELS.failure.exit(failure.exitCode);
    case 'lost':
      return RUN_LABELS.failure.lost;
    case 'agent':
      return failure.message;
  }
}

/** The warning of a run the agent called finished, whose session did not exit cleanly. */
export function exitWarning(run: AiRun): string | undefined {
  const code = run.failure?.exitCode;
  return run.state === 'finished' && code !== undefined && code !== 0
    ? RUN_LABELS.exitWarning(code)
    : undefined;
}

/** A run that stopped without being done: the only ones that can be taken up again. */
export const isRecoverable = (run: AiRun | undefined): run is AiRun =>
  run?.state === 'failed' || run?.state === 'needs-review';

export const canResume = (run: AiRun | undefined): boolean =>
  isRecoverable(run) && resumeBlocked(run) === undefined;

/** The command that continues the session by hand, in the terminal of the project. */
export const resumeCommand = (sessionId: string): string => `claude --resume ${sessionId}`;
