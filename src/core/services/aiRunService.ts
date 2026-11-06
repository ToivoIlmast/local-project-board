import type { AiRun, AiRunReport } from '../model/aiRun.js';
import type { EventSink, Storage } from '../ports.js';
import { BoardError } from '../errors.js';
import type { Launch, LaunchFailureKind } from '../model/launch.js';
import type { Task } from '../model/task.js';
import { isLaunchCurrent } from '../rules/launch.js';
import { reasonsOf, taskBlocked } from './readiness.js';
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

/**
 * One waiting runner, taken out of the waiting list for one request of work (ADR-0029 T94, K6).
 * Nobody else can be handed it until it is sent or released.
 */
export interface RunnerReservation {
  /** The runner declared `signals=run-failure` (K11). */
  reports: boolean;
  /** Tells the runner; false when its connection closed meanwhile, and nothing was sent. */
  send(requestId: string): boolean;
  /** Puts the runner back in the waiting list as it was; it was told nothing. */
  release(): void;
}

export interface RequestWorkInput {
  mode: 'new' | 'resume' | 'restart';
  /** Made by the board for this request, never taken from a body (K2). */
  requestId: string;
}

export interface RunFailureInput {
  requestId: string;
  kind: LaunchFailureKind;
  /** Cleaned already (K10); absent when nothing was left of it. */
  message?: string | undefined;
}

export interface AiRunService {
  begin(taskId: string, input: BeginInput): Promise<AiRun>;
  /**
   * `/run` of a work run, as one action under the lock of the task (ADR-0029 T94, K6): the
   * refusals of L1, then a runner is reserved, then `launch` is written, then the runner is told.
   * Resolves to the task as written, or to nothing when no runner waits: then nothing was written.
   */
  requestWork(
    taskId: string,
    input: RequestWorkInput,
    reserve: () => RunnerReservation | undefined,
  ): Promise<Task | undefined>;
  /**
   * A runner's report that the work run of a request did not begin (K8): a compare-and-set on the
   * current `launch` and its `requestId`. The first accepted report stays.
   */
  runFailure(
    taskId: string,
    input: RunFailureInput,
  ): Promise<{ recorded: boolean; launch: Launch }>;
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
  /**
   * Throws `TASK_BLOCKED` with the reasons when the task may not be started yet (ADR-0029 T78,
   * L1). Asked by `/run` after the refusals above; begin asks again itself (L2).
   */
  requireReady(taskId: string): Promise<void>;
}

/** The current runId from a task's aiRun, normalizing legacy records (no runId → 0). */
function currentRunId(aiRun: AiRun | undefined): number {
  if (!aiRun) return 0;
  return aiRun.runId ?? 0;
}

export function createAiRunService({
  storage,
  statuses,
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

  async function assertReady(taskId: string): Promise<void> {
    const reasons = await reasonsOf(storage, statuses, taskId);
    if (reasons.length > 0) throw taskBlocked(taskId, reasons);
  }

  function noRun(taskId: string): BoardError {
    return new BoardError(
      'NO_RUN_TO_RESTART',
      `Task "${taskId}" has no earlier AI run to start over. Start a new run instead.`,
      { id: taskId },
    );
  }

  return {
    // One action under the lock of the task (ADR-0029 T94, K6). The lock is not re-entrant, so
    // the refusals of L1 are checked here, in their order, and not through the `require*` above.
    requestWork: (taskId, input, reserve) =>
      locks.run(taskId, async () => {
        const task = await requireTask(taskId);
        if (task.aiRun?.state === 'working') throw inProgress(taskId);
        if (input.mode === 'resume' && task.aiRun?.sessionId === undefined) throw noSession(taskId);
        if (input.mode === 'restart' && task.aiRun === undefined) throw noRun(taskId);
        await assertReady(taskId);

        // No await between taking the runner and holding it: no other task can take it (I4).
        const runner = reserve();
        if (runner === undefined) return undefined;

        const launch: Launch = {
          requestId: input.requestId,
          requestedAt: now(),
          afterRunId: currentRunId(task.aiRun),
          reports: runner.reports,
        };
        let written: Task;
        try {
          written = await storage.updateTask(taskId, { launch });
        } catch (error) {
          // Nothing was written and the runner was told nothing: it waits as it did.
          runner.release();
          throw error;
        }

        if (!runner.send(input.requestId)) {
          // The runner went away during the write: no runner holds this request. If this write
          // fails too, the launch names a request nobody holds, shown as waiting (K17).
          await storage.updateTask(taskId, { launch: task.launch ?? null });
          return undefined;
        }
        events?.publish({ type: 'task.updated', task: written });
        return written;
      }),

    // A compare-and-set on the current launch and its request (K8); it never reads a runner and
    // never changes aiRun.
    runFailure: (taskId, input) =>
      locks.run(taskId, async () => {
        const task = await requireTask(taskId);
        const launch = task.launch;
        if (
          launch === undefined ||
          launch.requestId !== input.requestId ||
          !isLaunchCurrent(task)
        ) {
          throw new BoardError(
            'STALE_LAUNCH_REQUEST',
            `The request is not the current start of task "${taskId}": another request came, ` +
              'or a run has begun since.',
            { id: taskId },
          );
        }
        // The first accepted report stays, whatever a repeat says.
        if (launch.failure !== undefined) return { recorded: false, launch };

        const failed: Launch = {
          ...launch,
          failure: {
            kind: input.kind,
            ...(input.message === undefined ? {} : { message: input.message }),
            at: now(),
          },
        };
        const updated = await storage.updateTask(taskId, { launch: failed });
        events?.publish({ type: 'task.updated', task: updated });
        return { recorded: true, launch: failed };
      }),

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

    requireReady: (taskId) => locks.run(taskId, () => assertReady(taskId)),

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

        // The last guard on the server, after the refusals above and before anything is
        // written: a task that became blocked since /run is refused here (ADR-0029 T78, L2).
        await assertReady(taskId);

        const newRun: AiRun = {
          agent: task.aiRun?.agent ?? 'runner',
          state: 'working',
          runId: currentRunId(task.aiRun) + 1,
          sessionId: input.sessionId,
          mode: input.mode,
          ...(input.model !== undefined ? { model: input.model } : {}),
          startedAt: input.startedAt ?? now(),
        };
        // The run begins and the request it answers is gone, in one write, whoever begins (K5).
        const updated = await storage.updateTask(taskId, { aiRun: newRun, launch: null });
        events?.publish({ type: 'task.updated', task: updated });
        return updated.aiRun!;
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
