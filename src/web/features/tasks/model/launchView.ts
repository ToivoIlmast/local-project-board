import {
  isLaunchCurrent,
  type LaunchFailure,
  type LaunchFailureKind,
  type Task,
} from '../../../../contract/v1/index';

/**
 * What the page says about the last request of Claude Code on a task (ADR-0029 T94, K12), from
 * `task.launch` and `task.aiRun` and nothing else: the page keeps no state of its own about it.
 * A request without a report is never called a failure, and its age is no evidence (T45).
 */
export type LaunchView =
  | { kind: 'none' }
  | { kind: 'sent'; at: string; reports: boolean }
  | { kind: 'failed'; failure: LaunchFailure };

export function launchView(task: Pick<Task, 'aiRun' | 'launch'>): LaunchView {
  // A working run, a stale launch or none: only the run speaks, as it always did.
  if (task.launch === undefined || !isLaunchCurrent(task)) return { kind: 'none' };
  if (task.launch.failure !== undefined) return { kind: 'failed', failure: task.launch.failure };
  return { kind: 'sent', at: task.launch.requestedAt, reports: task.launch.reports };
}

export const LAUNCH_VIEW_LABELS = {
  sent: (time: string) =>
    `Sent to a runner at ${time}. Claude Code has not begun, and the runner has reported no ` +
    'problem. The board cannot tell whether the runner is still there; if nothing begins, look ' +
    'at its terminal.',
  sentToEarlier: (time: string) =>
    `Sent at ${time} to a runner of an earlier version, which cannot report a failed start. ` +
    'If nothing begins, look at its terminal.',
  failed: 'Claude Code did not start',
  why: {
    'claude-missing': 'The runner found no `claude` in the PATH.',
    'resume-refused': 'The runner found no finished session of Claude Code to resume.',
    'begin-refused': 'The board refused to begin the run.',
    'runner-error': 'The runner stopped before Claude Code began.',
  } satisfies Record<LaunchFailureKind, string>,
  runnerSaid: 'The runner said:',
  reportedAt: (time: string) => `Reported at ${time}.`,
} as const;
