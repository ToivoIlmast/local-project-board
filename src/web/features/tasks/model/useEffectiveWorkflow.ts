import { useEffect, useState } from 'react';
import type { EffectiveWorkflow, Task, WorkflowState } from '../../../../contract/v1/index';
import { useBoard } from '../../../api/react';

/** What an answer of the board was for: if any of it has changed, the answer is out of date. */
interface Asked {
  status: string;
  workflow: string;
  board: WorkflowState | undefined;
}

export interface EffectiveRead {
  /** The board's answer for the task as it is on the page now; never one for an earlier state. */
  effective: EffectiveWorkflow | undefined;
  error: string | undefined;
  retry: () => void;
}

/**
 * The settings a task runs with, as the board computes them (`GET /tasks/:id/workflow`). The
 * page does not work them out: it asks again whenever something they depend on changes — the
 * status of the task, its own settings, the settings of the board and the columns — and shows
 * nothing rather than an answer to an earlier question while the new one is on its way.
 */
export function useEffectiveWorkflow(task: Task, enabled: boolean): EffectiveRead {
  const { client, state } = useBoard();
  const board = state.workflow;
  const own = JSON.stringify(task.workflow ?? null);
  const [answer, setAnswer] = useState<{ effective: EffectiveWorkflow; asked: Asked }>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const asked: Asked = { status: task.status, workflow: own, board };
    client.taskWorkflow(task.id).then(
      (effective) => {
        if (!alive) return;
        setAnswer({ effective, asked });
        setError(undefined);
      },
      (failure: unknown) => {
        if (!alive) return;
        setError(failure instanceof Error ? failure.message : 'The board did not answer.');
      },
    );
    return () => {
      alive = false;
    };
  }, [client, task.id, task.status, own, board, enabled, attempt]);

  const current =
    answer !== undefined &&
    answer.asked.status === task.status &&
    answer.asked.workflow === own &&
    answer.asked.board === board;
  return {
    effective: current ? answer.effective : undefined,
    error,
    retry: () => setAttempt((count) => count + 1),
  };
}
