import { isLaunchCurrent, type LaunchFailure, type Task } from '../../../../contract/v1/index';

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
