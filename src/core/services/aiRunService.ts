import type { AiRun } from '../model/aiRun.js';
import type { Storage } from '../ports.js';
import { BoardError } from '../errors.js';

export interface AiRunServiceOptions {
  storage: Storage;
  statuses: string[];
}

export interface BeginInput {
  sessionId: string;
  mode: 'new' | 'resume' | 'restart';
  model?: string | undefined;
  startedAt?: string | undefined;
}

export interface EndInput {
  exitCode?: number | undefined;
  launchError?: string | undefined;
  endedAt?: string | undefined;
}

export interface AiRunService {
  begin(taskId: string, input: BeginInput): Promise<AiRun>;
  end(taskId: string, runId: number, input: EndInput): Promise<AiRun>;
}

/** The current runId from a task's aiRun, normalizing legacy records (no runId → 0). */
function currentRunId(aiRun: AiRun | undefined): number {
  if (!aiRun) return 0;
  return aiRun.runId ?? 0;
}

export function createAiRunService({ storage }: AiRunServiceOptions): AiRunService {
  const now = (): string => new Date().toISOString();

  async function requireTask(id: string) {
    const task = await storage.getTask(id);
    if (!task) throw new BoardError('TASK_NOT_FOUND', `Task "${id}" does not exist.`, { id });
    return task;
  }

  return {
    async begin(taskId, input) {
      const task = await requireTask(taskId);

      if (task.aiRun?.state === 'working') {
        throw new BoardError(
          'AI_RUN_IN_PROGRESS',
          `Task "${taskId}" already has an AI run in progress.`,
          { id: taskId },
        );
      }

      const prevRunId = currentRunId(task.aiRun);
      const runId = prevRunId + 1;

      const newRun: AiRun = {
        agent: task.aiRun?.agent ?? 'runner',
        state: 'working',
        runId,
        sessionId: input.sessionId,
        mode: input.mode,
        ...(input.model !== undefined ? { model: input.model } : {}),
        startedAt: input.startedAt ?? now(),
      };

      const updated = await storage.updateTask(taskId, { aiRun: newRun });
      return updated.aiRun!;
    },

    async end(taskId, runId, input) {
      const task = await requireTask(taskId);
      const existingRun = task.aiRun;

      if (!existingRun || currentRunId(existingRun) !== runId) {
        throw new BoardError(
          'STALE_AI_RUN',
          `Run ${runId} is not the current run for task "${taskId}".`,
          { id: taskId, runId },
        );
      }

      const endedAt = input.endedAt ?? now();
      let patch: AiRun;

      const isFinalState = (s: string) => s !== 'working';

      if (isFinalState(existingRun.state)) {
        // Agent already wrote a final verdict — preserve it, just add endedAt and exitCode
        patch = {
          ...existingRun,
          endedAt,
          ...(input.exitCode !== undefined && input.exitCode !== 0
            ? {
                failure: {
                  ...(existingRun.failure ?? { kind: 'exit', message: '' }),
                  exitCode: input.exitCode,
                },
              }
            : {}),
        };
      } else if (input.launchError !== undefined) {
        patch = {
          ...existingRun,
          state: 'failed',
          failure: { kind: 'launch', message: input.launchError },
          endedAt,
        };
      } else {
        const exitCode = input.exitCode ?? 0;
        if (exitCode !== 0) {
          patch = {
            ...existingRun,
            state: 'failed',
            failure: { kind: 'exit', message: `process exited with code ${exitCode}`, exitCode },
            endedAt,
          };
        } else {
          patch = {
            ...existingRun,
            state: 'failed',
            failure: { kind: 'exit', message: 'process exited with code 0 without a final state' },
            endedAt,
          };
        }
      }

      const updated = await storage.updateTask(taskId, { aiRun: patch });
      return updated.aiRun!;
    },
  };
}
