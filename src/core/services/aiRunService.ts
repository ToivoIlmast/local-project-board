import type { AiRun, AiRunReport } from '../model/aiRun.js';
import type { EventSink, Storage } from '../ports.js';
import { BoardError } from '../errors.js';
import type { Task } from '../model/task.js';
import { createTaskLocks, type TaskLocks } from './taskLocks.js';

export interface AiRunServiceOptions {
  storage: Storage;
  statuses: string[];
  events?: EventSink | undefined;
  /** Shared with the task service, so that clearing a run waits for its lifecycle (T45). */
  locks?: TaskLocks | undefined;
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
  /** The session of the run that ended; when given it must be the current one (T45). */
  sessionId?: string | undefined;
}

export interface AbandonInput {
  /** The session of the run the caller means; the run must still be that one (T45). */
  sessionId: string;
  /** Why the run is known, or confirmed, to be lost: the evidence, in words. */
  message: string;
}

export interface AiRunService {
  begin(taskId: string, input: BeginInput): Promise<AiRun>;
  end(taskId: string, runId: number, input: EndInput): Promise<AiRun>;
  report(taskId: string, runId: number, input: AiRunReport): Promise<Task>;
  /**
   * The run is lost: its runner died without an end (T45). Compare-and-set on the runId, the
   * session and `working`; writes `failed{lost}` and keeps runId and sessionId, so Resume works.
   */
  abandon(taskId: string, runId: number, input: AbandonInput): Promise<AiRun>;
  /** Throws `AI_RUN_IN_PROGRESS` when the task's run works; whatever a run would be (T45). */
  requireIdle(taskId: string): Promise<void>;
  /**
   * The session that Resume would continue: the one of the last run, which must be over (T36).
   * Throws `NO_SESSION_TO_RESUME` when there is none (a task that never ran, or a legacy run)
   * and `AI_RUN_IN_PROGRESS` when the run still works.
   */
  requireResumable(taskId: string): Promise<string>;
  /**
   * Restart starts the work of the last run over in a new session (T37): there must be a last
   * run, and it must be over. Throws `NO_RUN_TO_RESTART` or `AI_RUN_IN_PROGRESS`.
   */
  requireRestartable(taskId: string): Promise<void>;
}

/** The current runId from a task's aiRun, normalizing legacy records (no runId → 0). */
function currentRunId(aiRun: AiRun | undefined): number {
  if (!aiRun) return 0;
  return aiRun.runId ?? 0;
}

export function createAiRunService({
  storage,
  events,
  locks = createTaskLocks(),
}: AiRunServiceOptions): AiRunService {
  const now = (): string => new Date().toISOString();

  /** Writes the run and tells the open pages, as every change of a task is told (T45). */
  async function write(taskId: string, aiRun: AiRun): Promise<Task> {
    const updated = await storage.updateTask(taskId, { aiRun });
    events?.publish({ type: 'task.updated', task: updated });
    return updated;
  }

  function inProgress(taskId: string): BoardError {
    return new BoardError(
      'AI_RUN_IN_PROGRESS',
      `Task "${taskId}" already has an AI run in progress.`,
      { id: taskId },
    );
  }

  function stale(taskId: string, runId: number): BoardError {
    return new BoardError(
      'STALE_AI_RUN',
      `Run ${runId} is not the current run for task "${taskId}".`,
      { id: taskId, runId },
    );
  }

  /** The current run, if it is the one with this runId and, when given, this session. */
  async function requireCurrent(taskId: string, runId: number, sessionId?: string) {
    const task = await requireTask(taskId);
    const run = task.aiRun;
    if (!run || currentRunId(run) !== runId) throw stale(taskId, runId);
    if (sessionId !== undefined && run.sessionId !== sessionId) throw stale(taskId, runId);
    return run;
  }

  async function requireTask(id: string) {
    const task = await storage.getTask(id);
    if (!task) throw new BoardError('TASK_NOT_FOUND', `Task "${id}" does not exist.`, { id });
    return task;
  }

  function noSession(taskId: string): BoardError {
    return new BoardError(
      'NO_SESSION_TO_RESUME',
      `Task "${taskId}" has no session of Claude Code to resume: its last run did not record one. ` +
        'Start a new run instead.',
      { id: taskId },
    );
  }

  function noRun(taskId: string): BoardError {
    return new BoardError(
      'NO_RUN_TO_RESTART',
      `Task "${taskId}" has no earlier AI run to start over. Start a new run instead.`,
      { id: taskId },
    );
  }

  return {
    requireResumable: (taskId) =>
      locks.run(taskId, async () => {
        const task = await requireTask(taskId);
        const sessionId = task.aiRun?.sessionId;
        if (sessionId === undefined) throw noSession(taskId);
        if (task.aiRun?.state === 'working') throw inProgress(taskId);
        return sessionId;
      }),

    requireRestartable: (taskId) =>
      locks.run(taskId, async () => {
        const task = await requireTask(taskId);
        if (task.aiRun === undefined) throw noRun(taskId);
        if (task.aiRun.state === 'working') throw inProgress(taskId);
      }),

    requireIdle: (taskId) =>
      locks.run(taskId, async () => {
        const task = await requireTask(taskId);
        if (task.aiRun?.state === 'working') throw inProgress(taskId);
      }),

    // Read and written under the lock of the task: two begins at once make one run (T45).
    begin: (taskId, input) =>
      locks.run(taskId, async () => {
        const task = await requireTask(taskId);
        if (task.aiRun?.state === 'working') throw inProgress(taskId);

        // Restart starts an earlier run over; the handoff names its archive after that run.
        if (input.mode === 'restart' && task.aiRun === undefined) throw noRun(taskId);

        // Resume continues the session of the last run; any other session would be a new one.
        if (input.mode === 'resume' && task.aiRun?.sessionId !== input.sessionId) {
          throw noSession(taskId);
        }

        const newRun: AiRun = {
          agent: task.aiRun?.agent ?? 'runner',
          state: 'working',
          runId: currentRunId(task.aiRun) + 1,
          sessionId: input.sessionId,
          mode: input.mode,
          ...(input.model !== undefined ? { model: input.model } : {}),
          startedAt: input.startedAt ?? now(),
        };
        return (await write(taskId, newRun)).aiRun!;
      }),

    end: (taskId, runId, input) =>
      locks.run(taskId, async () => {
        const existingRun = await requireCurrent(taskId, runId, input.sessionId);
        const endedAt = input.endedAt ?? now();
        let patch: AiRun;

        if (existingRun.state !== 'working') {
          // A final verdict — the agent's, or lost — is kept; only endedAt and the exit code
          // are added.
          patch = {
            ...existingRun,
            endedAt,
            ...(input.exitCode !== undefined && input.exitCode !== 0
              ? {
                  failure: {
                    ...(existingRun.failure ?? {
                      kind: 'exit',
                      message: `process exited with code ${input.exitCode}`,
                    }),
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
          patch = {
            ...existingRun,
            state: 'failed',
            failure: {
              kind: 'exit',
              message:
                exitCode !== 0
                  ? `process exited with code ${exitCode}`
                  : 'process exited with code 0 without a final state',
              exitCode,
            },
            endedAt,
          };
        }

        return (await write(taskId, patch)).aiRun!;
      }),

    abandon: (taskId, runId, input) =>
      locks.run(taskId, async () => {
        const existingRun = await requireCurrent(taskId, runId, input.sessionId);
        if (existingRun.state !== 'working') {
          throw new BoardError(
            'AI_RUN_ALREADY_FINAL',
            `Run ${runId} on task "${taskId}" already has a final state.`,
            { id: taskId, runId },
          );
        }
        const patch: AiRun = {
          ...existingRun,
          state: 'failed',
          failure: { kind: 'lost', message: input.message },
        };
        return (await write(taskId, patch)).aiRun!;
      }),

    report: (taskId, runId, input) =>
      locks.run(taskId, async () => {
        const existingRun = await requireCurrent(taskId, runId);

        if (existingRun.state !== 'working') {
          throw new BoardError(
            'AI_RUN_ALREADY_FINAL',
            `Run ${runId} on task "${taskId}" already has a final state.`,
            { id: taskId, runId },
          );
        }

        const patch: AiRun = {
          ...existingRun,
          agent: input.agent,
          state: input.state,
          ...(input.checks !== undefined ? { checks: input.checks } : {}),
          ...(input.commit !== undefined ? { commit: input.commit } : {}),
          ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
          ...(input.state === 'failed' && input.message !== undefined
            ? { failure: { kind: 'agent', message: input.message } }
            : {}),
        };

        return write(taskId, patch);
      }),
  };
}
