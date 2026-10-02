import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeCodePrompt } from '../../src/contract/v1/index.js';
import { readRuntime, type RuntimeState } from '../../src/server/cli/runtime.js';
import { cli, stopBoards } from '../support/cli.js';
import { fakeClaude } from '../support/fakeClaude.js';
import { freePort, releasePorts } from '../support/ports.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

afterEach(async () => {
  await stopBoards();
  await releasePorts();
  await cleanTmpDirs();
});

async function api(state: RuntimeState, method: string, path: string, body?: unknown) {
  return fetch(`${state.url}api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface Started {
  root: string;
  state: RuntimeState;
  stop: () => Promise<void>;
}

async function boardWithTasks(): Promise<Started> {
  const root = await tmpDir();
  const start = await cli(['--port', String(await freePort()), '--no-open'], { cwd: root });
  const runtime = await readRuntime(root);
  if (runtime.kind !== 'state') throw new Error('unreachable');
  const state = runtime.state;
  for (const title of ['Extract the git adapter', 'Write the report']) {
    expect((await api(state, 'POST', '/tasks', { title, status: 'todo' })).status).toBe(201);
  }
  return { root, state, stop: () => start.stop?.() ?? Promise.resolve() };
}

const boardUrl = (state: RuntimeState): string => state.url.replace(/\/$/, '');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('runner lifecycle: begin / spawn / end (T33)', () => {
  it('passes --session-id <uuid> <prompt> as argv — no extra flags (INVARIANT)', async () => {
    const { root, state } = await boardWithTasks();
    const claude = await fakeClaude();

    await cli(['claude', 'T1'], { cwd: root, env: claude.env() });

    const calls = await claude.calls();
    expect(calls).toHaveLength(1);
    // Exactly 3 args: --session-id, uuid, prompt
    expect(calls[0]?.argv).toHaveLength(3);
    expect(calls[0]?.argv[0]).toBe('--session-id');
    expect(calls[0]?.argv[1]).toMatch(UUID_RE);
    expect(calls[0]?.argv[2]).toBe(claudeCodePrompt('T1', boardUrl(state)));
    // No additional flags beyond --session-id
    expect(calls[0]?.argv.slice(3).filter((a) => a.startsWith('-'))).toEqual([]);
  });

  it('exit 0 without agent report → failed{exit, exitCode:0} with sessionId (T30 regression)', async () => {
    // Mutation: remove end call → aiRun stays 'working' → test fails
    const { root, state } = await boardWithTasks();
    const claude = await fakeClaude();

    await cli(['claude', 'T1'], { cwd: root, env: claude.env({ exit: 0 }) });

    const calls = await claude.calls();
    const sessionIdFromArgv = calls[0]?.argv[1];
    expect(sessionIdFromArgv).toMatch(UUID_RE);

    const task = (await (await api(state, 'GET', '/tasks/T1')).json()) as {
      aiRun?: {
        state?: string;
        failure?: { kind?: string; exitCode?: number };
        sessionId?: string;
      };
    };
    expect(task.aiRun?.state).toBe('failed');
    expect(task.aiRun?.failure?.kind).toBe('exit');
    expect(task.aiRun?.failure?.exitCode).toBe(0);
    // sessionId on the run must match --session-id passed to claude
    expect(task.aiRun?.sessionId).toBe(sessionIdFromArgv);
  });

  it('begin fails → claude not spawned (INVARIANT: no session without run)', async () => {
    // Mutation: spawn before begin → claude IS called even when begin fails → test fails
    const { root, state } = await boardWithTasks();
    const claude = await fakeClaude();

    // Set T1 to already-in-progress so begin returns 409
    await api(state, 'POST', '/tasks/T1/ai-run', {
      sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
      mode: 'new',
    });

    const run = await cli(['claude', 'T1'], { cwd: root, env: claude.env() });

    expect(run.exitCode).toBe(1);
    expect(await claude.calls()).toHaveLength(0);
    expect(run.err.join('\n')).toMatch(/run in progress/i);
  });

  it('spawn error → failed{launch}', async () => {
    const { root, state } = await boardWithTasks();
    const dir = await tmpDir();
    // A file whose shebang points to a nonexistent interpreter: spawn emits ENOENT 'error'
    await writeFile(join(dir, 'claude'), '#!/nonexistent_interpreter_xyz_t33\necho hi\n', {
      mode: 0o755,
    });

    const run = await cli(['claude', 'T1'], { cwd: root, env: { PATH: dir } });

    expect(run.exitCode).toBe(1);
    const task = (await (await api(state, 'GET', '/tasks/T1')).json()) as {
      aiRun?: { state?: string; failure?: { kind?: string } };
    };
    expect(task.aiRun?.state).toBe('failed');
    expect(task.aiRun?.failure?.kind).toBe('launch');
  });

  it('agent reports finished, exits 1 → state=finished with exitCode:1', async () => {
    const { root, state } = await boardWithTasks();
    const claude = await fakeClaude();

    const run = await cli(['claude', 'T1'], {
      cwd: root,
      env: claude.env({ agent: true, exit: 1 }),
    });

    expect(run.exitCode).toBe(1);
    const tasks = (await (await api(state, 'GET', '/tasks')).json()) as {
      id: string;
      aiRun?: unknown;
    }[];
    const task1 = tasks.find((t) => t.id === 'T1') as
      { aiRun?: { state?: string; failure?: { exitCode?: number } } } | undefined;
    expect(task1?.aiRun?.state).toBe('finished');
    expect(task1?.aiRun?.failure?.exitCode).toBe(1);
  });

  it('process exits via signal → end is still sent (SIGINT regression)', async () => {
    // Mutation: end only on code !== null → signal exit (code=null) skips end → aiRun stays 'working'
    const { root, state } = await boardWithTasks();
    const claude = await fakeClaude();

    await cli(['claude', 'T1'], { cwd: root, env: claude.env({ signal: 'SIGINT' }) });

    const task = (await (await api(state, 'GET', '/tasks/T1')).json()) as {
      aiRun?: { state?: string };
    };
    // end was called — aiRun must not be stuck in 'working'
    expect(task.aiRun?.state).not.toBe('working');
    expect(task.aiRun?.state).toBe('failed');
  });
});
