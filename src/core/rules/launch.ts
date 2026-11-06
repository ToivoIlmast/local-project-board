import type { AiRun } from '../model/aiRun.js';
import type { Launch } from '../model/launch.js';

/**
 * Whether the `launch` of a task still speaks for it (ADR-0029 T94, K4): no run has begun since
 * the request, and none works. One predicate, not a state: `runId` moves only through begin, on
 * every board version, so "a run has begun since" is exactly "`runId` has moved". The board, the
 * route `run-failure` and the page all ask this, and nothing else.
 */
export function isLaunchCurrent(task: {
  aiRun?: AiRun | undefined;
  launch?: Launch | undefined;
}): boolean {
  if (task.launch === undefined) return false;
  return (task.aiRun?.runId ?? 0) === task.launch.afterRunId && task.aiRun?.state !== 'working';
}
