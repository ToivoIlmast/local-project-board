import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { BoardError } from '../../../src/core/errors.js';
import type { Launch } from '../../../src/core/model/launch.js';
import type { Storage, TaskPatch } from '../../../src/core/ports.js';
import { isLaunchCurrent } from '../../../src/core/rules/launch.js';
import {
  createAiRunService,
  type AiRunService,
  type RunnerReservation,
} from '../../../src/core/services/aiRunService.js';
import { createTaskLocks } from '../../../src/core/services/taskLocks.js';
import { recordingEventSink, type RecordingEventSink } from '../../support/events.js';
import { createMemoryStore, inMemoryStorage } from '../../support/inMemoryStorage.js';

/**
 * `/run` of a work run as one action under the lock of the task, and the runner's report of a
 * start that did not begin (ADR-0029 T94, K4–K8, K13). The runner is a stand-in here, so every
 * step of K6 can be failed on purpose; test/api/runFailure.test.ts runs the same over HTTP.
 */

const statuses = ['backlog', 'todo', 'in-progress', 'done'];
const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';

let storage: Storage;
let events: RecordingEventSink;
let service: AiRunService;

beforeEach(async () => {
  storage = inMemoryStorage(createMemoryStore());
  await storage.init();
  events = recordingEventSink();
  service = createAiRunService({ storage, statuses, events, locks: createTaskLocks() });
});

async function createTask(title = 'Do something'): Promise<string> {
  return (await storage.createTask({ title, status: 'todo', rank: 'a0', body: '', labels: [] })).id;
}

const launchOf = async (id: string): Promise<Launch | undefined> =>
  (await storage.getTask(id))?.launch;

/** A runner as the dispatcher reserves one: it records what it was told and when. */
interface FakeRunner extends RunnerReservation {
  sent: string[];
  released: number;
  /** What `launch` was on the storage at the moment the runner was told. */
  launchWhenSent: (Launch | undefined)[];
  closed: boolean;
}

function fakeRunner(taskId: string, reports = true): FakeRunner {
  const runner: FakeRunner = {
    reports,
    sent: [],
    released: 0,
    launchWhenSent: [],
    closed: false,
    send(requestId) {
      if (runner.closed) return false;
      runner.sent.push(requestId);
      // Synchronous, as the dispatcher's `response.end` is: what the runner can read next.
      const stored = (storage as unknown as { peek?: (id: string) => Launch | undefined }).peek;
      runner.launchWhenSent.push(stored?.(taskId));
      return true;
    },
    release() {
      runner.released += 1;
    },
  };
  return runner;
}

/** Reads what the storage holds right now, without waiting on its queue. */
function peekable(store = createMemoryStore()): Storage {
  const inner = inMemoryStorage(store);
  return Object.assign(inner, { peek: (id: string) => store.tasks.get(id)?.launch });
}

const request = (mode: 'new' | 'resume' | 'restart' = 'new', requestId = randomUUID()) => ({
  mode,
  requestId,
});

describe('/run of a work run: refusals first, in the order of L1 (K6 step 1)', () => {
  it('refuses a task that does not exist, and reserves no runner', async () => {
    const reserve = jest.fn(() => fakeRunner('T9'));
    await expect(service.requestWork('T9', request(), reserve)).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('refuses while a run works, before Resume or readiness is asked (AI_RUN_IN_PROGRESS)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: SESSION, mode: 'new' });
    const reserve = jest.fn(() => fakeRunner(id));

    for (const mode of ['new', 'resume', 'restart'] as const) {
      await expect(service.requestWork(id, request(mode), reserve)).rejects.toMatchObject({
        code: 'AI_RUN_IN_PROGRESS',
      });
    }
    expect(reserve).not.toHaveBeenCalled();
    expect(await launchOf(id)).toBeUndefined();
  });

  it('refuses Resume without a session and Restart without a run, and writes nothing', async () => {
    const id = await createTask();
    const reserve = jest.fn(() => fakeRunner(id));

    await expect(service.requestWork(id, request('resume'), reserve)).rejects.toMatchObject({
      code: 'NO_SESSION_TO_RESUME',
    });
    await expect(service.requestWork(id, request('restart'), reserve)).rejects.toMatchObject({
      code: 'NO_RUN_TO_RESTART',
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(await launchOf(id)).toBeUndefined();
  });

  it('refuses a blocked task last (TASK_BLOCKED), and writes nothing', async () => {
    const first = await createTask('First');
    const second = await createTask('Second');
    await storage.updateTask(second, { dependsOn: [first] });
    const reserve = jest.fn(() => fakeRunner(second));

    await expect(service.requestWork(second, request(), reserve)).rejects.toMatchObject({
      code: 'TASK_BLOCKED',
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(await launchOf(second)).toBeUndefined();
  });
});

describe('/run of a work run: reserve, write, send (K6 steps 2–5, K7)', () => {
  beforeEach(async () => {
    storage = peekable();
    await storage.init();
    service = createAiRunService({ storage, statuses, events, locks: createTaskLocks() });
  });

  it('writes launch before the runner is told, and tells it the same requestId (INVARIANT I1)', async () => {
    const id = await createTask();
    const runner = fakeRunner(id);
    const requestId = randomUUID();

    const task = await service.requestWork(id, request('new', requestId), () => runner);

    expect(runner.sent).toEqual([requestId]);
    // At the moment of the send the launch of this very request was already stored.
    expect(runner.launchWhenSent).toEqual([expect.objectContaining({ requestId })]);
    expect(task?.launch).toEqual({
      requestId,
      requestedAt: expect.any(String),
      afterRunId: 0,
      reports: true,
    });
    expect(await launchOf(id)).toEqual(task?.launch);
    expect(runner.released).toBe(0);
    expect(events.events).toEqual([{ type: 'task.updated', task }]);
  });

  it('records whether the reserved runner reports: an earlier runner gives reports: false (K11)', async () => {
    const id = await createTask();
    const task = await service.requestWork(id, request(), () => fakeRunner(id, false));
    expect(task?.launch?.reports).toBe(false);
  });

  it('records the runId of the run before the request as afterRunId (K4)', async () => {
    const id = await createTask();
    const begun = await service.begin(id, { sessionId: SESSION, mode: 'new' });
    await service.end(id, begun.runId ?? 0, { exitCode: 1, sessionId: SESSION });

    const task = await service.requestWork(id, request('resume'), () => fakeRunner(id));

    expect(task?.launch?.afterRunId).toBe(1);
    expect(isLaunchCurrent(task!)).toBe(true);
  });

  it('writes nothing when no runner waits (INVARIANT I3)', async () => {
    const id = await createTask();

    const answer = await service.requestWork(id, request(), () => undefined);

    expect(answer).toBeUndefined();
    expect(await launchOf(id)).toBeUndefined();
    expect(events.events).toEqual([]);
  });

  it('releases the runner and tells it nothing when launch cannot be written (K6 step 3)', async () => {
    const id = await createTask();
    const failing = failingWrites(storage, () => true);
    const svc = createAiRunService({
      storage: failing,
      statuses,
      events,
      locks: createTaskLocks(),
    });
    const runner = fakeRunner(id);

    await expect(svc.requestWork(id, request(), () => runner)).rejects.toThrow('disk full');

    expect(runner.sent).toEqual([]);
    expect(runner.released).toBe(1);
    expect(await launchOf(id)).toBeUndefined();
    expect(events.events).toEqual([]);
  });

  it('writes the previous launch back when the runner went away during the write (K6 step 4)', async () => {
    const id = await createTask();
    const earlier = (await service.requestWork(id, request(), () => fakeRunner(id)))?.launch;
    events.events.length = 0;
    const gone = fakeRunner(id);
    gone.closed = true;

    const answer = await service.requestWork(id, request(), () => gone);

    expect(answer).toBeUndefined();
    expect(gone.sent).toEqual([]);
    expect(await launchOf(id)).toEqual(earlier);
    expect(events.events).toEqual([]);
  });

  it('removes the launch again when there was none before and the runner went away', async () => {
    const id = await createTask();
    const gone = fakeRunner(id);
    gone.closed = true;

    expect(await service.requestWork(id, request(), () => gone)).toBeUndefined();
    expect(await launchOf(id)).toBeUndefined();
  });

  it('fails with the write back: the launch then names a request nobody holds (K6 step 4, K17)', async () => {
    const id = await createTask();
    let writes = 0;
    const failing = failingWrites(storage, () => ++writes === 2);
    const svc = createAiRunService({
      storage: failing,
      statuses,
      events,
      locks: createTaskLocks(),
    });
    const gone = fakeRunner(id);
    gone.closed = true;

    await expect(svc.requestWork(id, request(), () => gone)).rejects.toThrow('disk full');
    // The one case of two failures at once: shown as waiting, never as running.
    const left = await launchOf(id);
    expect(left).toBeDefined();
    expect(isLaunchCurrent({ launch: left })).toBe(true);
  });

  it('a new request replaces the previous launch, with its failure (I5)', async () => {
    const id = await createTask();
    const first = randomUUID();
    await service.requestWork(id, request('new', first), () => fakeRunner(id));
    await service.runFailure(id, { requestId: first, kind: 'claude-missing' });

    const second = randomUUID();
    const task = await service.requestWork(id, request('new', second), () => fakeRunner(id));

    expect(task?.launch?.requestId).toBe(second);
    expect(task?.launch?.failure).toBeUndefined();
  });

  it('serializes two /run of one task: the second sees the first one written (I4)', async () => {
    const id = await createTask();
    const a = fakeRunner(id);
    const b = fakeRunner(id);
    const [first, second] = await Promise.all([
      service.requestWork(id, request(), () => a),
      service.requestWork(id, request(), () => b),
    ]);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    // The last one handed is the current one, and it is what is stored.
    expect((await launchOf(id))?.requestId).toBe(second?.launch?.requestId);
    expect(first?.launch?.requestId).not.toBe(second?.launch?.requestId);
  });
});

describe('begin removes launch, in its one write (K5)', () => {
  it('begin of any caller removes the launch and makes it stale', async () => {
    const id = await createTask();
    await service.requestWork(id, request(), () => fakeRunner(id));
    const writes = jest.spyOn(storage, 'updateTask');

    await service.begin(id, { sessionId: SESSION, mode: 'new' });

    expect(await launchOf(id)).toBeUndefined();
    // One write that makes the run working and removes the launch together.
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]?.[1]).toMatchObject({ launch: null, aiRun: { state: 'working' } });
  });

  it('a begin that is refused leaves the launch as it was', async () => {
    const first = await createTask('First');
    const id = await createTask('Second');
    await service.requestWork(id, request(), () => fakeRunner(id));
    await storage.updateTask(id, { dependsOn: [first] });
    const before = await launchOf(id);

    await expect(service.begin(id, { sessionId: SESSION, mode: 'new' })).rejects.toMatchObject({
      code: 'TASK_BLOCKED',
    });
    expect(await launchOf(id)).toEqual(before);
  });

  it('end, report and abandon keep the launch as it is: runId did not move (K13)', async () => {
    const id = await createTask();
    const run = await service.begin(id, { sessionId: SESSION, mode: 'new' });
    const runId = run.runId ?? 0;
    await service.report(id, runId, { agent: 'claude-code', state: 'failed', message: 'no' });
    // A request after the run ended, then the late end of that run, and an agent's word.
    const task = await service.requestWork(id, request('resume'), () => fakeRunner(id));
    const launch = task?.launch;
    await service.end(id, runId, { exitCode: 1, sessionId: SESSION });
    expect(await launchOf(id)).toEqual(launch);
    expect(isLaunchCurrent((await storage.getTask(id))!)).toBe(true);

    // Abandon needs a working run: begin removes the launch, so make one by hand to keep.
    await storage.updateTask(id, {
      aiRun: { agent: 'runner', state: 'working', runId, sessionId: SESSION },
      launch: launch ?? null,
    });
    await service.abandon(id, runId, { sessionId: SESSION, message: 'lost' });
    expect(await launchOf(id)).toEqual(launch);
  });
});

describe('run-failure: a compare-and-set on the current launch (K8)', () => {
  async function handed(reports = true): Promise<{ id: string; requestId: string }> {
    const id = await createTask();
    const requestId = randomUUID();
    await service.requestWork(id, request('new', requestId), () => fakeRunner(id, reports));
    events.events.length = 0;
    return { id, requestId };
  }

  it.each(['claude-missing', 'resume-refused', 'begin-refused', 'runner-error'] as const)(
    'records %s on the current request, with the time, and tells the pages',
    async (kind) => {
      const { id, requestId } = await handed();

      const answer = await service.runFailure(id, { requestId, kind, message: 'Why.' });

      expect(answer.recorded).toBe(true);
      expect(answer.launch.failure).toEqual({ kind, message: 'Why.', at: expect.any(String) });
      expect((await launchOf(id))?.failure).toEqual(answer.launch.failure);
      expect(events.events).toEqual([
        { type: 'task.updated', task: expect.objectContaining({ launch: answer.launch }) },
      ]);
    },
  );

  it('stores no message when none was sent', async () => {
    const { id, requestId } = await handed();
    const answer = await service.runFailure(id, { requestId, kind: 'runner-error' });
    expect(answer.launch.failure).toEqual({ kind: 'runner-error', at: expect.any(String) });
  });

  it('keeps the first report: the same again, or another kind or message, is recorded: false (INVARIANT)', async () => {
    const { id, requestId } = await handed();
    const first = await service.runFailure(id, { requestId, kind: 'claude-missing', message: 'A' });
    events.events.length = 0;

    const same = await service.runFailure(id, { requestId, kind: 'claude-missing', message: 'A' });
    const other = await service.runFailure(id, { requestId, kind: 'begin-refused', message: 'B' });

    expect(same).toEqual({ recorded: false, launch: first.launch });
    expect(other).toEqual({ recorded: false, launch: first.launch });
    expect(await launchOf(id)).toEqual(first.launch);
    expect(events.events).toEqual([]);
  });

  it('refuses another requestId: an old request cannot touch a new one (INVARIANT)', async () => {
    const { id, requestId: old } = await handed();
    await service.requestWork(id, request(), () => fakeRunner(id));
    const current = await launchOf(id);

    await expect(
      service.runFailure(id, { requestId: old, kind: 'claude-missing' }),
    ).rejects.toMatchObject({ code: 'STALE_LAUNCH_REQUEST', details: { id } });
    expect(await launchOf(id)).toEqual(current);
  });

  it('refuses a request after which a run has begun, and never touches the run (INVARIANT)', async () => {
    const { id, requestId } = await handed();
    await service.begin(id, { sessionId: SESSION, mode: 'new' });
    const run = (await storage.getTask(id))?.aiRun;

    await expect(
      service.runFailure(id, { requestId, kind: 'begin-refused' }),
    ).rejects.toMatchObject({ code: 'STALE_LAUNCH_REQUEST' });
    expect((await storage.getTask(id))?.aiRun).toEqual(run);
    expect(await launchOf(id)).toBeUndefined();
  });

  it('refuses a stale launch that an earlier board left behind: runId moved (K14)', async () => {
    const { id, requestId } = await handed();
    // An earlier board begins without removing the launch, and its run ends.
    const launch = await launchOf(id);
    await service.begin(id, { sessionId: SESSION, mode: 'new' });
    await storage.updateTask(id, {
      aiRun: { agent: 'runner', state: 'failed', runId: 1, sessionId: SESSION },
      launch: launch ?? null,
    });

    await expect(
      service.runFailure(id, { requestId, kind: 'claude-missing' }),
    ).rejects.toMatchObject({ code: 'STALE_LAUNCH_REQUEST' });
  });

  it('refuses while a run works, even with the launch left in place (K4)', async () => {
    const { id, requestId } = await handed();
    const launch = await launchOf(id);
    await storage.updateTask(id, {
      aiRun: { agent: 'claude-code', state: 'working' },
      launch: launch ?? null,
    });
    await expect(
      service.runFailure(id, { requestId, kind: 'claude-missing' }),
    ).rejects.toMatchObject({ code: 'STALE_LAUNCH_REQUEST' });
  });

  it('refuses a task without a launch, and a task that does not exist', async () => {
    const id = await createTask();
    await expect(
      service.runFailure(id, { requestId: randomUUID(), kind: 'runner-error' }),
    ).rejects.toMatchObject({ code: 'STALE_LAUNCH_REQUEST' });
    await expect(
      service.runFailure('T99', { requestId: randomUUID(), kind: 'runner-error' }),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  });

  it('two reports at once: exactly one is recorded (atomic under the lock)', async () => {
    const { id, requestId } = await handed();
    const answers = await Promise.all(
      (['claude-missing', 'begin-refused', 'runner-error', 'resume-refused'] as const).map((kind) =>
        service.runFailure(id, { requestId, kind }),
      ),
    );
    expect(answers.filter((answer) => answer.recorded)).toHaveLength(1);
    const stored = (await launchOf(id))?.failure;
    for (const answer of answers) expect(answer.launch.failure).toEqual(stored);
  });

  it('begin and a report at once: either the report is refused or begin removes it (K13)', async () => {
    for (let round = 0; round < 10; round += 1) {
      const { id, requestId } = await handed();
      const [, report] = await Promise.allSettled([
        service.begin(id, { sessionId: SESSION, mode: 'new' }),
        service.runFailure(id, { requestId, kind: 'begin-refused' }),
      ]);
      const task = (await storage.getTask(id))!;
      expect(task.aiRun?.state).toBe('working');
      expect(task.launch).toBeUndefined();
      if (report.status === 'rejected') {
        expect(report.reason).toBeInstanceOf(BoardError);
        expect((report.reason as BoardError).code).toBe('STALE_LAUNCH_REQUEST');
      }
    }
  });

  it('never changes aiRun', async () => {
    const id = await createTask();
    const run = await service.begin(id, { sessionId: SESSION, mode: 'new' });
    await service.end(id, run.runId ?? 0, { exitCode: 1, sessionId: SESSION });
    const before = (await storage.getTask(id))?.aiRun;
    const requestId = randomUUID();
    await service.requestWork(id, request('restart', requestId), () => fakeRunner(id));

    await service.runFailure(id, { requestId, kind: 'begin-refused' });

    expect((await storage.getTask(id))?.aiRun).toEqual(before);
  });
});

/** The storage, with the writes that `fail` picks thrown before anything is written. */
function failingWrites(inner: Storage, fail: (patch: TaskPatch) => boolean): Storage {
  return Object.assign(Object.create(inner) as Storage, {
    updateTask: async (id: string, patch: TaskPatch) => {
      if (fail(patch)) throw new Error('disk full');
      return inner.updateTask(id, patch);
    },
  });
}
