import type { AiRun } from '../../../../contract/v1/index';
import { taskT } from '../i18n/details';
import { resumeBlocked } from './claudeLaunch';

/**
 * How the run of a task is told to the person (T39): why it ended, in words, and what can be done
 * about it. Pure, so that the table of states and kinds is read in one place.
 */

/** The failure of a run that did not end well, in words; nothing for a run that did. */
export function failureText(run: AiRun): string | undefined {
  const failure = run.failure;
  if (failure === undefined || run.state === 'finished' || run.state === 'working') {
    return undefined;
  }
  switch (failure.kind) {
    case 'launch':
      return taskT('ai.run.failure.launch');
    case 'exit':
      return failure.exitCode === undefined
        ? taskT('ai.run.failure.exit')
        : taskT('ai.run.failure.exitCode', { code: failure.exitCode });
    case 'lost':
      return taskT('ai.run.failure.lost');
    case 'agent':
      return failure.message;
  }
}

/** The warning of a run the agent called finished, whose session did not exit cleanly. */
export function exitWarning(run: AiRun): string | undefined {
  const code = run.failure?.exitCode;
  return run.state === 'finished' && code !== undefined && code !== 0
    ? taskT('ai.run.exitWarning', { code })
    : undefined;
}

/** A run that stopped without being done: the only ones that can be taken up again. */
export const isRecoverable = (run: AiRun | undefined): run is AiRun =>
  run?.state === 'failed' || run?.state === 'needs-review';

export const canResume = (run: AiRun | undefined): boolean =>
  isRecoverable(run) && resumeBlocked(run) === undefined;

/** The command that continues the session by hand, in the terminal of the project. */
export const resumeCommand = (sessionId: string): string => `claude --resume ${sessionId}`;
