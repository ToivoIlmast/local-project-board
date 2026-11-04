import { readdir, readFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { readRuntime, writeRuntime, type RuntimeState } from '../../src/server/cli/runtime.js';
import { cli, cliInBackground, stopBoards } from '../support/cli.js';
import { fakeClaude, type FakeClaude } from '../support/fakeClaude.js';
import { initRepo } from '../support/gitRepo.js';
import { freePort, releasePorts } from '../support/ports.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

/**
 * The readiness gate from the command line (T86): `handoff <ID>` refuses a blocked task, from the
 * running board and from the files alike, unless a run of it works (ADR-0032 §8, F2); and a
 * runner of today, which this task does not change, takes `409 TASK_BLOCKED` from begin as any
 * refusal of begin: it does not start `claude` (ADR-0029 T78, L5).
 */

const proxies: Server[] = [];

afterEach(async () => {
  await stopBoards();
  await Promise.all(
    proxies.splice(0).map(
      (proxy) =>
        new Promise<void>((resolve) => {
          proxy.closeAllConnections();
          proxy.close(() => resolve());
        }),
    ),
  );
  await releasePorts();
  await cleanTmpDirs();
});

const WAITING = /^Waiting for Send to AI → Claude Code/;
const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';

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

/** A running board in a repository with T1 (the dependency) and T2 (its dependant), both todo. */
async function boardWithTasks(): Promise<Started> {
  const root = await initRepo(await tmpDir());
  const start = await cli(['--port', String(await freePort()), '--no-open'], { cwd: root });
  expect(start.exitCode).toBe(0);
  const runtime = await readRuntime(root);
  if (runtime.kind !== 'state') throw new Error('unreachable');
  const state = runtime.state;
  for (const title of ['Dependency', 'Dependant']) {
    expect((await api(state, 'POST', '/tasks', { title, status: 'todo' })).status).toBe(201);
  }
  return { root, state, stop: () => start.stop?.() ?? Promise.resolve() };
}

const block = async (state: RuntimeState) =>
  expect((await api(state, 'PATCH', '/tasks/T2', { dependsOn: ['T1'] })).status).toBe(200);

const aiRunOf = async (state: RuntimeState, id: string) =>
  ((await (await api(state, 'GET', `/tasks/${id}`)).json()) as { aiRun?: unknown }).aiRun;

const journals = async (root: string): Promise<string[]> =>
  readdir(join(root, '.board', 'runner')).catch(() => []);

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const callsOf = (claude: FakeClaude, count: number) =>
  until(claude.calls, (calls) => calls.length >= count);

describe('local-project-board handoff <ID> of a blocked task (F2)', () => {
  it('fails with the reasons from the running board, and does not fall back to the files', async () => {
    const { root, state } = await boardWithTasks();
    await block(state);

    const run = await cli(['handoff', 'T2'], { cwd: root });

    expect(run.exitCode).toBe(1);
    expect(run.out).toEqual([]);
    expect(run.err.join('\n')).toMatch(/T2/);
    expect(run.err.join('\n')).toMatch(/blocked/i);
    expect(run.err.join('\n')).toContain('T1');
    expect(run.text).not.toContain(state.token);
  });

  it('fails the same way from the files when no board runs, in the same words', async () => {
    const { root, state, stop } = await boardWithTasks();
    await block(state);
    const online = await cli(['handoff', 'T2'], { cwd: root });
    await stop();

    const offline = await cli(['handoff', 'T2'], { cwd: root });

    expect(offline.exitCode).toBe(1);
    expect(offline.out).toEqual([]);
    expect(offline.err.join('\n')).toBe(online.err.join('\n'));
  });

  it('is given while a run of the task works, online and offline (INVARIANT)', async () => {
    const { root, state, stop } = await boardWithTasks();
    expect(
      (await api(state, 'POST', '/tasks/T2/ai-run', { sessionId: SESSION, mode: 'new' })).status,
    ).toBe(200);
    await block(state);

    const online = await cli(['handoff', 'T2'], { cwd: root });
    await stop();
    const offline = await cli(['handoff', 'T2'], { cwd: root });

    for (const run of [online, offline]) {
      expect(run.exitCode).toBe(0);
      expect(run.out.join('\n')).toContain('# Task T2: Dependant');
    }
  });

  it('a task that is not blocked is given as before', async () => {
    const { root } = await boardWithTasks();

    const run = await cli(['handoff', 'T2'], { cwd: root });

    expect(run.exitCode).toBe(0);
    expect(run.out.join('\n')).toContain('# Task T2: Dependant');
  });
});

describe('export does not carry readiness (F3)', () => {
  it('holds the tasks as they are stored, without their reasons', async () => {
    const { root, state } = await boardWithTasks();
    await block(state);

    const run = await cli(['export'], { cwd: root });

    expect(run.exitCode).toBe(0);
    const snapshot = JSON.parse(run.out.join('\n')) as { tasks: Record<string, unknown>[] };
    expect(snapshot.tasks.map((task) => task.id)).toEqual(['T1', 'T2']);
    expect(snapshot.tasks.every((task) => !('readiness' in task))).toBe(true);
    expect(run.out.join('\n')).not.toContain('readiness');
  });
});

/**
 * A proxy in front of the board that makes T2 blocked the moment a runner begins on it, before
 * begin reaches the board: the race between `/run` and begin, played by the real runner against
 * the real board. The runner finds the proxy through the runtime file, as it finds any board.
 */
async function blockingBeforeBegin(board: Started): Promise<{ begins: () => number }> {
  const target = new URL(board.state.url);
  let begins = 0;
  const proxy = createServer((incoming, outgoing) => {
    void (async () => {
      if (incoming.method === 'POST' && incoming.url === '/api/v1/tasks/T2/ai-run') {
        begins += 1;
        await block(board.state);
      }
      const forwarded = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          method: incoming.method,
          path: incoming.url,
          headers: { ...incoming.headers, host: target.host },
        },
        (answer) => {
          outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(outgoing);
        },
      );
      forwarded.on('error', () => outgoing.destroy());
      incoming.pipe(forwarded);
    })();
  });
  proxies.push(proxy);
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as AddressInfo).port;
  await writeRuntime({ ...board.state, port, url: `http://127.0.0.1:${port}/` });
  return { begins: () => begins };
}

describe('a runner of today takes TASK_BLOCKED from begin as a refusal of begin (L5, HYPOTHESIS of T86)', () => {
  it('`claude <ID>` on a blocked task: exits 1 with the reasons, starts no claude, writes no journal (INVARIANT)', async () => {
    const { root, state } = await boardWithTasks();
    await block(state);
    const claude = await fakeClaude();

    const run = await cli(['claude', 'T2'], { cwd: root, env: claude.env() });

    expect(run.exitCode).toBe(1);
    expect(run.err.join('\n')).toMatch(/blocked/i);
    expect(run.err.join('\n')).toContain('T1');
    expect(await claude.calls()).toEqual([]);
    expect(await journals(root)).toEqual([]);
    expect(await aiRunOf(state, 'T2')).toBeUndefined();
  });

  it('`claude --wait`: a task blocked between /run and begin starts no claude, and the runner waits again (INVARIANT)', async () => {
    const board = await boardWithTasks();
    const { root, state } = board;
    const proxy = await blockingBeforeBegin(board);
    const claude = await fakeClaude();
    const runner = cliInBackground(['claude', '--wait'], { cwd: root, env: claude.env() });
    await runner.printed(WAITING);

    // /run passes: T2 is ready when it is sent.
    const sent = await api(state, 'POST', '/tasks/T2/run', { agent: 'claude-code' });
    expect(sent.status).toBe(200);

    // The runner is refused at begin, says why, and waits for the next one.
    await runner.printed(/blocked/i);
    await runner.printed(WAITING, 2);
    expect(proxy.begins()).toBe(1);
    expect(runner.err.join('\n')).toContain('T1');
    expect(await claude.calls()).toEqual([]);
    expect(await journals(root)).toEqual([]);
    expect(await aiRunOf(state, 'T2')).toBeUndefined();
    const file = await readFile(join(root, '.board', 'tasks', 'T2', 'task.md'), 'utf8');
    expect(file).not.toContain('aiRun');

    // It is still a working runner: the next task it is sent starts as before.
    expect((await api(state, 'POST', '/tasks/T1/run', { agent: 'claude-code' })).status).toBe(200);
    await callsOf(claude, 1);
    expect((await claude.calls())[0]?.argv.join(' ')).toContain('/tasks/T1/handoff');
    await runner.stop();
  }, 20_000);
});
