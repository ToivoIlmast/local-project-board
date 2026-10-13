import type { Storage } from '../../../src/core/ports.js';
import { createAiRunService, type AiRunService } from '../../../src/core/services/aiRunService.js';
import { createMemoryStore, inMemoryStorage } from '../../support/inMemoryStorage.js';
import { recordingEventSink } from '../../support/events.js';

/**
 * State-machine tests for the runner's begin/end lifecycle (T31).
 * Each test names the invariant it protects and the mutation that breaks it.
 */

const statuses = ['backlog', 'todo', 'in-progress', 'done'];

let storage: Storage;
let service: AiRunService;

beforeEach(async () => {
  storage = inMemoryStorage(createMemoryStore());
  await storage.init();
  service = createAiRunService({ storage, statuses });
});

async function createTask(): Promise<string> {
  const task = await storage.createTask({
    title: 'Do something',
    status: 'in-progress',
    rank: 'a0',
    body: '',
    labels: [],
  });
  return task.id;
}

async function getAiRun(id: string) {
  const task = await storage.getTask(id);
  return task?.aiRun;
}

describe('begin (POST /tasks/:id/ai-run)', () => {
  it('no run → begin → state: working (INVARIANT)', async () => {
    const id = await createTask();

    await service.begin(id, {
      sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
      mode: 'new',
      model: 'claude-sonnet-4-6',
    });

    const run = await getAiRun(id);
    expect(run?.state).toBe('working');
    expect(run?.runId).toBe(1);
    expect(run?.sessionId).toBe('a1b2c3d4-e5f6-4890-abcd-ef0123456789');
  });

  it('finished → begin → working; runId increments (INVARIANT: two begins give different runIds)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789', mode: 'new' });
    const runA = await getAiRun(id);
    // Simulate agent finishing
    await storage.updateTask(id, { aiRun: { ...runA!, state: 'finished' } });

    await service.begin(id, { sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456790', mode: 'new' });

    const runB = await getAiRun(id);
    expect(runB?.state).toBe('working');
    expect(runB?.runId).toBe(2);
    expect(runB?.runId).not.toBe(runA?.runId);
  });

  it('working → begin → 409 AI_RUN_IN_PROGRESS, file not changed (INVARIANT)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789', mode: 'new' });
    const beforeRun = await getAiRun(id);

    await expect(
      service.begin(id, { sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456790', mode: 'new' }),
    ).rejects.toMatchObject({ code: 'AI_RUN_IN_PROGRESS' });

    expect(await getAiRun(id)).toEqual(beforeRun);
  });
});

describe('end (POST /tasks/:id/ai-run/:runId/end)', () => {
  it('working → end(exitCode: 0) → failed{exit} (INVARIANT: T30 cannot stay in working)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789', mode: 'new' });
    const run = await getAiRun(id);

    await service.end(id, run!.runId!, { exitCode: 1 });

    const after = await getAiRun(id);
    expect(after?.state).toBe('failed');
    expect(after?.failure).toEqual({ kind: 'exit', message: expect.any(String), exitCode: 1 });
    expect(after?.endedAt).toBeDefined();
  });

  it('working → end(launchError) → failed{launch} (INVARIANT)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789', mode: 'new' });
    const run = await getAiRun(id);

    await service.end(id, run!.runId!, { launchError: 'claude not found in PATH' });

    const after = await getAiRun(id);
    expect(after?.state).toBe('failed');
    expect(after?.failure?.kind).toBe('launch');
  });

  it('finished → end(exitCode: 1) → finished preserved, exitCode added (INVARIANT: agent verdict not lost)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789', mode: 'new' });
    const run = await getAiRun(id);
    // Simulate agent writing finished before process exits
    await storage.updateTask(id, { aiRun: { ...run!, state: 'finished', checks: 'passed' } });

    await service.end(id, run!.runId!, { exitCode: 1 });

    const after = await getAiRun(id);
    expect(after?.state).toBe('finished');
    expect(after?.failure?.exitCode).toBe(1);
    expect(after?.endedAt).toBeDefined();
  });

  it('end with stale runId → 409 STALE_AI_RUN, file not changed (INVARIANT)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789', mode: 'new' });
    const run = await getAiRun(id);
    const staleRunId = 0; // old run from before begin

    await expect(service.end(id, staleRunId, { exitCode: 0 })).rejects.toMatchObject({
      code: 'STALE_AI_RUN',
    });

    expect(await getAiRun(id)).toEqual(run);
  });
});

describe('legacy aiRun normalization', () => {
  it('task with aiRun but no runId is normalized to runId: 0 on read', async () => {
    const id = await createTask();
    // Write legacy-style aiRun (no runId) with a finished state
    await storage.updateTask(id, {
      aiRun: { agent: 'old-agent', state: 'finished', startedAt: '2026-09-20T10:00:00Z' },
    });

    // begin should produce runId: 1 (prev 0 + 1)
    await service.begin(id, { sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789', mode: 'restart' });

    const run = await getAiRun(id);
    expect(run?.runId).toBe(1);
  });
});

describe('begin with mode: resume (T36)', () => {
  const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';

  it('keeps the session and takes the next runId (INVARIANT)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: SESSION, mode: 'new' });
    await service.end(id, 1, { exitCode: 1 });

    await service.begin(id, { sessionId: SESSION, mode: 'resume' });

    expect(await getAiRun(id)).toMatchObject({
      runId: 2,
      sessionId: SESSION,
      mode: 'resume',
      state: 'working',
    });
  });

  it('refuses a session that is not the one of the last run, and writes nothing (INVARIANT)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: SESSION, mode: 'new' });
    await service.end(id, 1, { exitCode: 1 });
    const before = await getAiRun(id);

    await expect(
      service.begin(id, { sessionId: '00000000-0000-4000-8000-000000000000', mode: 'resume' }),
    ).rejects.toMatchObject({ code: 'NO_SESSION_TO_RESUME' });

    expect(await getAiRun(id)).toEqual(before);
  });

  it('refuses when there is no earlier session at all', async () => {
    const id = await createTask();
    await expect(service.begin(id, { sessionId: SESSION, mode: 'resume' })).rejects.toMatchObject({
      code: 'NO_SESSION_TO_RESUME',
    });
  });

  it('requireResumable: the session of a run that is over; not of one that works, nor of none (INVARIANT)', async () => {
    const id = await createTask();
    await expect(service.requireResumable(id)).rejects.toMatchObject({
      code: 'NO_SESSION_TO_RESUME',
    });

    await service.begin(id, { sessionId: SESSION, mode: 'new' });
    await expect(service.requireResumable(id)).rejects.toMatchObject({
      code: 'AI_RUN_IN_PROGRESS',
    });

    await service.end(id, 1, { exitCode: 1 });
    await expect(service.requireResumable(id)).resolves.toBe(SESSION);
  });

  it('requireResumable: a legacy run without sessionId is not resumable', async () => {
    const id = await createTask();
    await storage.updateTask(id, {
      aiRun: { agent: 'old-agent', state: 'finished', startedAt: '2026-09-20T10:00:00Z' },
    });
    await expect(service.requireResumable(id)).rejects.toMatchObject({
      code: 'NO_SESSION_TO_RESUME',
    });
  });
});

describe('begin with mode: restart (T37)', () => {
  const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';
  const OTHER = '00000000-0000-4000-8000-000000000000';

  it('takes a new session and the next runId (INVARIANT)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: SESSION, mode: 'new' });
    await service.end(id, 1, { exitCode: 1 });

    await service.begin(id, { sessionId: OTHER, mode: 'restart' });

    expect(await getAiRun(id)).toMatchObject({
      runId: 2,
      sessionId: OTHER,
      mode: 'restart',
      state: 'working',
    });
  });

  it('refuses a task that never ran, and writes nothing (INVARIANT)', async () => {
    const id = await createTask();

    await expect(service.begin(id, { sessionId: OTHER, mode: 'restart' })).rejects.toMatchObject({
      code: 'NO_RUN_TO_RESTART',
    });
    expect(await getAiRun(id)).toBeUndefined();
  });

  it('requireRestartable: a run that is over, legacy or not; not one that works, nor none (INVARIANT)', async () => {
    const id = await createTask();
    await expect(service.requireRestartable(id)).rejects.toMatchObject({
      code: 'NO_RUN_TO_RESTART',
    });

    await service.begin(id, { sessionId: SESSION, mode: 'new' });
    await expect(service.requireRestartable(id)).rejects.toMatchObject({
      code: 'AI_RUN_IN_PROGRESS',
    });

    await service.end(id, 1, { exitCode: 1 });
    await expect(service.requireRestartable(id)).resolves.toBeUndefined();

    // A legacy run has no session, but it is a run: its work can be started over.
    await storage.updateTask(id, {
      aiRun: { agent: 'old-agent', state: 'failed', startedAt: '2026-09-20T10:00:00Z' },
    });
    await expect(service.requireRestartable(id)).resolves.toBeUndefined();
  });

  it('requireRestartable reads under the lock of the task: a begin before it is seen (INVARIANT)', async () => {
    // Mutation: requireRestartable outside the lock → it reads the run before begin writes it.
    const id = await createTask();
    await service.begin(id, { sessionId: SESSION, mode: 'new' });
    await service.end(id, 1, { exitCode: 1 });

    const [begun, checked] = await Promise.allSettled([
      service.begin(id, { sessionId: OTHER, mode: 'restart' }),
      service.requireRestartable(id),
    ]);

    expect(begun.status).toBe('fulfilled');
    expect(checked).toMatchObject({ status: 'rejected', reason: { code: 'AI_RUN_IN_PROGRESS' } });
  });
});

describe('lost runs: abandon, CAS and the lifecycle lock (T45)', () => {
  const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';
  const OTHER = '00000000-0000-4000-8000-000000000000';

  it('two begins at once make one run with runId 1, never two runs with the same runId (INVARIANT)', async () => {
    // Mutation: begin outside the lock → both read "no run" and both write runId 1 → fails.
    const id = await createTask();

    const results = await Promise.allSettled([
      service.begin(id, { sessionId: SESSION, mode: 'new' }),
      service.begin(id, { sessionId: OTHER, mode: 'new' }),
    ]);

    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'AI_RUN_IN_PROGRESS' });
    const winner = (won[0] as PromiseFulfilledResult<{ sessionId?: string }>).value;
    expect(await getAiRun(id)).toMatchObject({
      runId: 1,
      state: 'working',
      sessionId: winner.sessionId,
    });
  });

  it('abandon: working → failed{lost}, keeping runId and sessionId (INVARIANT)', async () => {
    const id = await createTask();
    const begun = await service.begin(id, { sessionId: SESSION, mode: 'new' });

    const run = await service.abandon(id, 1, { sessionId: SESSION, message: 'process is gone' });

    expect(run).toEqual({
      ...begun,
      state: 'failed',
      failure: { kind: 'lost', message: 'process is gone' },
    });
    expect(await getAiRun(id)).toEqual(run);
  });

  it('abandon refuses a stale runId, a foreign session and a run that is over, writing nothing (INVARIANT)', async () => {
    // Mutation: drop any one of the three comparisons → that case writes failed{lost} → fails.
    const id = await createTask();
    await service.begin(id, { sessionId: SESSION, mode: 'new' });
    await service.end(id, 1, { exitCode: 1 });
    await service.begin(id, { sessionId: SESSION, mode: 'resume' });
    const working = await getAiRun(id);

    await expect(
      service.abandon(id, 1, { sessionId: SESSION, message: 'x' }),
    ).rejects.toMatchObject({ code: 'STALE_AI_RUN' });
    await expect(service.abandon(id, 2, { sessionId: OTHER, message: 'x' })).rejects.toMatchObject({
      code: 'STALE_AI_RUN',
    });
    expect(await getAiRun(id)).toEqual(working);

    await service.end(id, 2, { exitCode: 0, sessionId: SESSION });
    const over = await getAiRun(id);
    await expect(
      service.abandon(id, 2, { sessionId: SESSION, message: 'x' }),
    ).rejects.toMatchObject({ code: 'AI_RUN_ALREADY_FINAL' });
    expect(await getAiRun(id)).toEqual(over);
  });

  it('abandon of a task without a run is STALE_AI_RUN', async () => {
    const id = await createTask();
    await expect(
      service.abandon(id, 1, { sessionId: SESSION, message: 'x' }),
    ).rejects.toMatchObject({ code: 'STALE_AI_RUN' });
    expect(await getAiRun(id)).toBeUndefined();
  });

  it('after abandon, Resume continues the same session as runId 2 (INVARIANT: monotonic runId)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: SESSION, mode: 'new' });
    await service.abandon(id, 1, { sessionId: SESSION, message: 'lost' });

    await expect(service.requireResumable(id)).resolves.toBe(SESSION);
    await service.begin(id, { sessionId: SESSION, mode: 'resume' });

    expect(await getAiRun(id)).toMatchObject({ runId: 2, sessionId: SESSION, state: 'working' });
  });

  it('end with the session of another run is STALE_AI_RUN and writes nothing (INVARIANT)', async () => {
    // Mutation: ignore sessionId in end → the foreign end writes failed{exit} → fails.
    const id = await createTask();
    await service.begin(id, { sessionId: SESSION, mode: 'new' });
    const before = await getAiRun(id);

    await expect(service.end(id, 1, { exitCode: 0, sessionId: OTHER })).rejects.toMatchObject({
      code: 'STALE_AI_RUN',
    });
    expect(await getAiRun(id)).toEqual(before);
  });

  it('a late end or report of an abandoned run does not touch the run that replaced it (INVARIANT)', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: SESSION, mode: 'new' });
    await service.abandon(id, 1, { sessionId: SESSION, message: 'lost' });
    await service.begin(id, { sessionId: SESSION, mode: 'resume' });
    const current = await getAiRun(id);

    await expect(service.end(id, 1, { exitCode: 0, sessionId: SESSION })).rejects.toMatchObject({
      code: 'STALE_AI_RUN',
    });
    await expect(
      service.report(id, 1, { agent: 'claude-code', state: 'finished' }),
    ).rejects.toMatchObject({ code: 'STALE_AI_RUN' });
    expect(await getAiRun(id)).toEqual(current);
  });

  it('a late end of the abandoned run itself keeps failed{lost}', async () => {
    const id = await createTask();
    await service.begin(id, { sessionId: SESSION, mode: 'new' });
    await service.abandon(id, 1, { sessionId: SESSION, message: 'confirmed' });

    await service.end(id, 1, { exitCode: 0, sessionId: SESSION });

    expect(await getAiRun(id)).toMatchObject({
      state: 'failed',
      failure: { kind: 'lost', message: 'confirmed' },
    });
  });

  it('every change of the lifecycle is published as task.updated (INVARIANT)', async () => {
    // Mutation: drop the publish of begin, end or abandon → its event is missing → fails.
    const events = recordingEventSink();
    service = createAiRunService({ storage, statuses, events });
    const id = await createTask();

    await service.begin(id, { sessionId: SESSION, mode: 'new' });
    expect(events.last()).toMatchObject({
      type: 'task.updated',
      task: { aiRun: { state: 'working' } },
    });
    await service.abandon(id, 1, { sessionId: SESSION, message: 'lost' });
    expect(events.last()).toMatchObject({
      type: 'task.updated',
      task: { aiRun: { failure: { kind: 'lost' } } },
    });
    await service.end(id, 1, { exitCode: 0, sessionId: SESSION });
    expect(events.last()).toMatchObject({
      type: 'task.updated',
      task: { aiRun: { endedAt: expect.any(String) } },
    });
    expect(events.types()).toEqual(['task.updated', 'task.updated', 'task.updated']);
  });

  it('a refused change publishes nothing', async () => {
    const events = recordingEventSink();
    service = createAiRunService({ storage, statuses, events });
    const id = await createTask();
    await expect(service.end(id, 1, { exitCode: 0 })).rejects.toMatchObject({
      code: 'STALE_AI_RUN',
    });
    expect(events.events).toEqual([]);
  });

  it('requireIdle refuses a task whose run works, whatever the mode (INVARIANT)', async () => {
    const id = await createTask();
    await expect(service.requireIdle(id)).resolves.toBeUndefined();
    await service.begin(id, { sessionId: SESSION, mode: 'new' });
    await expect(service.requireIdle(id)).rejects.toMatchObject({ code: 'AI_RUN_IN_PROGRESS' });
  });
});
