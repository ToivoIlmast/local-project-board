import type { Storage } from '../../../src/core/ports.js';
import { createAiRunService, type AiRunService } from '../../../src/core/services/aiRunService.js';
import { createMemoryStore, inMemoryStorage } from '../../support/inMemoryStorage.js';

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
