import type { AiRun, AiRunReport } from '../model/aiRun.js';
import type { ConsoleJournalEntry, EventSink, Storage } from '../ports.js';
import { BoardError } from '../errors.js';
import type { Launch, LaunchFailureKind } from '../model/launch.js';
import type { Task } from '../model/task.js';
import {
  finalizeMessages,
  foldConsole,
  type ConsoleFinalizeCause,
  type ConsoleFoldEntry,
  type ConsoleState,
} from '../rules/console.js';
import { pageConsole, type ConsolePageQuery } from '../rules/consolePage.js';
import { isLaunchCurrent } from '../rules/launch.js';
import { assertNotArchived } from './archive.js';
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
  /** The comment of the request, as the runner received it; kept in the record of this run only. */
  comment?: string | undefined;
  /** The run is a Console mode run: it has a journal of the console (plan C7). */
  console?: true | undefined;
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

/** A batch of the runner's console events: `events[i]` has `runnerSeq = fromRunnerSeq + i`. */
export interface ConsoleBatch {
  fromRunnerSeq: number;
  events: readonly ConsoleJournalEntry['event'][];
}

/** What the server confirms of a batch (plan §3.3). */
export interface ConsoleAppendResult {
  /** The `runnerSeq` of the last runner event in the journal: the runner's new `ackedRunnerSeq`. */
  lastRunnerSeq: number;
  /** The messages still `accepted` after the batch. */
  awaitingDelivery: number;
}

export interface ConsolePage {
  entries: ConsoleJournalEntry[];
  /** Of the whole journal, not of the page. */
  state: ConsoleState;
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
   * Resolves to the task as written, to nothing when no runner waits, or to `outdated` when
   * runners wait but none can take this request (it has a comment, and they cannot carry it):
   * then nothing was written either.
   */
  requestWork(
    taskId: string,
    input: RequestWorkInput,
    reserve: () => RunnerReservation | undefined | 'outdated',
  ): Promise<Task | undefined | 'outdated'>;
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
  /**
   * Console mode (plan C7): writes the events of a batch to the journal of the run. A
   * compare-and-set on the runId, the session and the run being a console run; `aiRun.state` and
   * `endedAt` are not read, so the journal goes on after the agent's report and takes the rest of
   * a spool after the end (§5.3). Events the journal has already are skipped by `runnerSeq`, a
   * gap is noted once (`events_missing`), and `process.exited` settles the messages (§9.4).
   * Publishes one `console.appended` when something was written. Refused with `STALE_AI_RUN`.
   */
  appendConsole(
    taskId: string,
    runId: number,
    sessionId: string,
    batch: ConsoleBatch,
  ): Promise<ConsoleAppendResult>;
  /**
   * A page of the journal of a console run, current or earlier, and the state `foldConsole`
   * computes from all of it. `STALE_AI_RUN` when the task has no such console run.
   */
  readConsole(taskId: string, runId: number, query: ConsolePageQuery): Promise<ConsolePage>;
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

  /** `foldConsole` over what the provider read: the same entries, seen through the model. */
  function foldOf(entries: readonly ConsoleJournalEntry[], lost: boolean): ConsoleState {
    return foldConsole(entries as unknown as readonly ConsoleFoldEntry[], { lost });
  }

  function notConsole(taskId: string, runId: number): BoardError {
    return new BoardError(
      'STALE_AI_RUN',
      `Run ${runId} of task "${taskId}" is not a console run, or is not the current run.`,
      { id: taskId, runId },
    );
  }

  /** Writes entries of the server or the runner, and tells the open pages once (plan C7). */
  async function appendEntries(
    taskId: string,
    run: AiRun,
    entries: ConsoleJournalEntry[],
  ): Promise<void> {
    const last = entries.at(-1);
    if (last === undefined) return;
    await storage.appendConsole(
      { taskId, runId: currentRunId(run), sessionId: run.sessionId ?? '' },
      entries,
    );
    events?.publish({
      type: 'console.appended',
      taskId,
      runId: currentRunId(run),
      lastSeq: last.seq,
    });
  }

  /**
   * The server's events that settle the messages of a console run whose process is gone (§9.4),
   * written under the lock of the task. Nothing for a run that is not a console run, nor when
   * the journal has nothing to settle: the model is idempotent (plan C5).
   */
  async function settleMessages(
    taskId: string,
    run: AiRun,
    cause: ConsoleFinalizeCause,
  ): Promise<void> {
    if (run.console !== true) return;
    const entries = await storage.readConsole(taskId, currentRunId(run));
    const settled = finalizeMessages(foldOf(entries, cause === 'lost'), cause);
    let seq = entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
    const at = now();
    await appendEntries(
      taskId,
      run,
      settled.map((event) => ({ seq: ++seq, at, source: 'server' as const, event: { ...event } })),
    );
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
        assertNotArchived(task);
        if (task.aiRun?.state === 'working') throw inProgress(taskId);
        if (input.mode === 'resume' && task.aiRun?.sessionId === undefined) throw noSession(taskId);
        if (input.mode === 'restart' && task.aiRun === undefined) throw noRun(taskId);
        await assertReady(taskId);

        // No await between taking the runner and holding it: no other task can take it (I4).
        const runner = reserve();
        if (runner === undefined || runner === 'outdated') return runner;

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
        assertNotArchived(task);
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
          ...(input.comment !== undefined ? { comment: input.comment } : {}),
          ...(input.console === true ? { console: true as const } : {}),
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

        const ended = (await write(taskId, patch)).aiRun!;
        // The runner sends process.exited before the end; when it could not, this settles them.
        await settleMessages(taskId, ended, 'ended');
        return ended;
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
        const lost = (await write(taskId, patch)).aiRun!;
        await settleMessages(taskId, lost, 'lost');
        return lost;
      }),

    appendConsole: (taskId, runId, sessionId, batch) =>
      locks.run(taskId, async () => {
        const run = await requireCurrent(taskId, runId, sessionId);
        if (run.console !== true) throw notConsole(taskId, runId);

        const entries = await storage.readConsole(taskId, runId);
        let seq = entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
        let cursor = entries.reduce(
          (max, entry) => (entry.runnerSeq === undefined ? max : Math.max(max, entry.runnerSeq)),
          0,
        );

        // Event by event against the cursor (plan §3.3): what is written is skipped, what is
        // next is written, and the first event after a gap is written behind one notice.
        const at = now();
        const fresh: ConsoleJournalEntry[] = [];
        batch.events.forEach((event, index) => {
          const runnerSeq = batch.fromRunnerSeq + index;
          if (runnerSeq <= cursor) return;
          if (runnerSeq > cursor + 1) {
            fresh.push({
              seq: ++seq,
              at,
              source: 'server',
              event: {
                kind: 'notice',
                level: 'warning',
                code: 'events_missing',
                fromRunnerSeq: cursor + 1,
                toRunnerSeq: runnerSeq - 1,
              },
            });
          }
          fresh.push({ seq: ++seq, at, source: 'runner', runnerSeq, event });
          cursor = runnerSeq;
        });

        // The process is gone: what it was not told, nor started, is settled in the same write.
        if (fresh.some((entry) => entry.event.kind === 'process.exited')) {
          const settled = finalizeMessages(foldOf([...entries, ...fresh], false), 'exited');
          for (const event of settled) {
            fresh.push({ seq: ++seq, at, source: 'server', event: { ...event } });
          }
        }

        await appendEntries(taskId, run, fresh);
        const state = foldOf([...entries, ...fresh], false);
        return { lastRunnerSeq: cursor, awaitingDelivery: state.counters.awaitingDelivery };
      }),

    readConsole: async (taskId, runId, query) => {
      const task = await requireTask(taskId);
      const run =
        currentRunId(task.aiRun) === runId
          ? task.aiRun
          : task.aiRunHistory?.find((earlier) => currentRunId(earlier) === runId);
      if (run?.console !== true) throw notConsole(taskId, runId);
      const entries = await storage.readConsole(taskId, runId);
      return {
        entries: pageConsole(entries, query),
        state: foldOf(entries, run.failure?.kind === 'lost'),
      };
    },

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
