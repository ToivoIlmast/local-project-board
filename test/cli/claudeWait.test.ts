import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeCodePrompt } from '../../src/contract/v1/index.js';
import { readRuntime, type RuntimeState } from '../../src/server/cli/runtime.js';
import { cli, cliInBackground, stopBoards } from '../support/cli.js';
import { fakeClaude, type FakeClaude } from '../support/fakeClaude.js';
import { initRepo } from '../support/gitRepo.js';
import { freePort, releasePorts } from '../support/ports.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

/**
 * `local-project-board claude --wait` (T27): the runner that turns Send to AI → Claude Code in
 * the board into a real session of Claude Code in this terminal. The board hands it a task id;
 * it starts `claude` exactly as `claude <ID>` does (T19): the prompt that points at the live
 * handoff of that task, in the root of the project, in a new process.
 */

afterEach(async () => {
  await stopBoards();
  await releasePorts();
  await cleanTmpDirs();
});

const WAITING = /^Waiting for Send to AI → Claude Code/;

async function api(state: RuntimeState, method: string, path: string, body?: unknown) {
  return fetch(`${state.url}api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** What the page does when Claude Code is chosen in Send to AI; the same request, no more. */
const sendToClaude = (state: RuntimeState, id: string, model?: string) =>
  api(state, 'POST', `/tasks/${id}/run`, {
    agent: 'claude-code',
    ...(model === undefined ? {} : { model }),
  });

async function runningState(root: string): Promise<RuntimeState> {
  const runtime = await readRuntime(root);
  if (runtime.kind !== 'state') throw new Error('The board is not running.');
  return runtime.state;
}

interface Started {
  root: string;
  state: RuntimeState;
  stop: () => Promise<void>;
}

/** A running board in a git repository, with T1 and T2 and a rule of the project's own. */
async function boardWithTasks(root?: string): Promise<Started> {
  const where = root ?? (await initRepo(await tmpDir()));
  if (root === undefined) {
    await writeFile(
      join(where, 'board.config.yaml'),
      'ai:\n  rules:\n    - Keep commits small.\n',
      'utf8',
    );
  }
  const start = await cli(['--port', String(await freePort()), '--no-open'], { cwd: where });
  expect(start.exitCode).toBe(0);
  const state = await runningState(where);
  if (root === undefined) {
    for (const title of ['Extract the git adapter', 'Write the report']) {
      expect((await api(state, 'POST', '/tasks', { title, status: 'todo' })).status).toBe(201);
    }
  }
  return { root: where, state, stop: () => start.stop?.() ?? Promise.resolve() };
}

const boardUrl = (state: RuntimeState): string => state.url.replace(/\/$/, '');

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Fails a command that should have refused at once but went on waiting instead. */
const refusedWithin = (ms: number): Promise<never> =>
  new Promise((_resolve, reject) =>
    setTimeout(() => reject(new Error(`Still waiting after ${ms} ms instead of refusing.`)), ms),
  );

const callsOf = (claude: FakeClaude, count: number) =>
  until(claude.calls, (calls) => calls.length >= count);

describe('local-project-board claude --wait', () => {
  describe('Send to AI → Claude Code starts a session', () => {
    it('of Claude Code, on exactly the task that was sent, as a new session in the project (INVARIANT)', async () => {
      const { root, state } = await boardWithTasks();
      const claude = await fakeClaude();
      // Typed anywhere in the project: the session still starts at its root.
      const deeper = join(root, 'packages', 'app');
      await mkdir(deeper, { recursive: true });
      const runner = cliInBackground(['claude', '--wait'], { cwd: deeper, env: claude.env() });
      await runner.printed(WAITING);

      const answer = await sendToClaude(state, 'T2');

      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({ taskId: 'T2', agent: 'claude-code' });
      const [call] = await callsOf(claude, 1);
      // --session-id <uuid> <prompt>: the prompt is last, no other flags.
      expect(call?.argv).toHaveLength(3);
      expect(call?.argv[0]).toBe('--session-id');
      const prompt = call?.argv[2] ?? '';
      expect(prompt).toBe(claudeCodePrompt('T2', boardUrl(state)));
      expect(prompt).toContain('/api/v1/tasks/T2/handoff');
      expect(prompt).not.toContain('T1');
      expect(await realpath(call?.cwd ?? '')).toBe(await realpath(root));
      await runner.printed(/^Starting Claude Code on T2\./);
    });

    it("with no --model when none was chosen: the model is the user's own setting (INVARIANT, T35)", async () => {
      const { root, state } = await boardWithTasks();
      const claude = await fakeClaude();
      const runner = cliInBackground(['claude', '--wait'], { cwd: root, env: claude.env() });
      await runner.printed(WAITING);

      await sendToClaude(state, 'T1');

      const [call] = await callsOf(claude, 1);
      expect(call?.argv.some((argument) => argument.startsWith('--model'))).toBe(false);
      expect(call?.argv).toHaveLength(3);
      const task = (await (await api(state, 'GET', '/tasks/T1')).json()) as {
        aiRun?: Record<string, unknown>;
      };
      expect(task.aiRun).not.toHaveProperty('model');
    });

    it('with --model and the model as two arguments of their own, and the same model in aiRun (INVARIANT, T35)', async () => {
      const { root, state } = await boardWithTasks();
      const claude = await fakeClaude();
      const runner = cliInBackground(['claude', '--wait'], { cwd: root, env: claude.env() });
      await runner.printed(WAITING);

      expect((await sendToClaude(state, 'T2', 'sonnet')).status).toBe(200);

      const [call] = await callsOf(claude, 1);
      const argv = call?.argv ?? [];
      // Two elements, never `--model=sonnet`; the prompt stays last and whole.
      expect(argv).toHaveLength(5);
      expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
      expect(argv.filter((argument) => argument.includes('sonnet'))).toEqual(['sonnet']);
      expect(argv[argv.length - 1]).toBe(claudeCodePrompt('T2', boardUrl(state)));
      const task = (await (await api(state, 'GET', '/tasks/T2')).json()) as {
        aiRun?: { model?: string };
      };
      expect(task.aiRun?.model).toBe('sonnet');
    });

    it('whose prompt leads to the handoff of that task: the task, its workflow, the AI instructions and the rules of the project', async () => {
      const { root, state } = await boardWithTasks();
      const claude = await fakeClaude();
      const runner = cliInBackground(['claude', '--wait'], {
        cwd: root,
        env: claude.env({ agent: 'read' }),
      });
      await runner.printed(WAITING);
      expect((await sendToClaude(state, 'T2')).status).toBe(200);

      const [read] = await until(claude.reads, (reads) => reads.length >= 1);
      expect(read?.url).toBe(`${boardUrl(state)}/api/v1/tasks/T2/handoff`);
      // The handoff is served by the board (beginRun updates it before Claude reads it).
      const handoff = read?.handoff ?? '';
      expect(handoff).toMatch(/^# Task T2: Write the report\n/);
      expect(handoff).not.toMatch(/^# Task T1:/m);
      expect(handoff).toContain('## How to work on this task');
      expect(handoff).toContain('Work in a branch of your own, `task/T2-write-the-report`');
      expect(handoff).toContain('report your run to the board');
      expect(handoff).toContain('# local-project-board API (v1)');
      expect(handoff).toContain('### Project rules');
      expect(handoff).toContain('- Keep commits small.');
      // The session learns the token the way every client does, from the board: not from us.
      expect(handoff).not.toContain(state.token);
      expect(JSON.stringify(await claude.calls())).not.toContain(state.token);
    });

    it('whose agent can give its result back to the board, on that task only', async () => {
      const { root, state } = await boardWithTasks();
      const claude = await fakeClaude();
      const runner = cliInBackground(['claude', '--wait'], {
        cwd: root,
        env: claude.env({ agent: true }),
      });
      await runner.printed(WAITING);

      await sendToClaude(state, 'T2');
      await runner.printed(/^The session on T2 ended \(exit code 0\)\./);

      const task = (await (await api(state, 'GET', '/tasks/T2')).json()) as { aiRun?: unknown };
      expect(task.aiRun).toMatchObject({
        agent: 'claude-code',
        state: 'finished',
        checks: 'skipped',
      });
      expect((await api(state, 'GET', '/tasks/T2/documents/report.md')).status).toBe(200);
      const other = (await (await api(state, 'GET', '/tasks/T1')).json()) as object;
      expect(other).not.toHaveProperty('aiRun');
      expect((await api(state, 'GET', '/tasks/T1/documents/report.md')).status).toBe(404);
    });
  });

  describe('one session at a time, each for the task it was sent', () => {
    it('waits again after a session and starts the next task in a new process (INVARIANT)', async () => {
      const { root, state } = await boardWithTasks();
      const claude = await fakeClaude();
      const runner = cliInBackground(['claude', '--wait'], { cwd: root, env: claude.env() });
      await runner.printed(WAITING);

      expect((await sendToClaude(state, 'T1')).status).toBe(200);
      await runner.printed(WAITING, 2);
      expect((await sendToClaude(state, 'T2')).status).toBe(200);

      const calls = await callsOf(claude, 2);
      expect(calls.map((call) => call.argv[call.argv.length - 1])).toEqual([
        claudeCodePrompt('T1', boardUrl(state)),
        claudeCodePrompt('T2', boardUrl(state)),
      ]);
      expect(calls[0]?.pid).not.toBe(calls[1]?.pid);
    });

    it('does not start another task while a session runs: the board refuses the click (INVARIANT)', async () => {
      const { root, state } = await boardWithTasks();
      const claude = await fakeClaude();
      const release = join(await tmpDir(), 'release');
      const runner = cliInBackground(['claude', '--wait'], {
        cwd: root,
        env: claude.env({ holdUntil: release }),
      });
      await runner.printed(WAITING);

      expect((await sendToClaude(state, 'T1')).status).toBe(200);
      await callsOf(claude, 1);
      const refused = await sendToClaude(state, 'T2');

      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
        'NO_AGENT_RUNNER',
      );
      await writeFile(release, '', 'utf8');
      await runner.printed(WAITING, 2);
      // T2 was never started behind the person's back, not even after the session ended.
      expect((await claude.calls()).map((call) => call.argv[call.argv.length - 1])).toEqual([
        claudeCodePrompt('T1', boardUrl(state)),
      ]);
    });

    it('says how a session ended badly, and keeps waiting', async () => {
      const { root, state } = await boardWithTasks();
      const claude = await fakeClaude();
      const runner = cliInBackground(['claude', '--wait'], {
        cwd: root,
        env: claude.env({ exit: 3 }),
      });
      await runner.printed(WAITING);

      await sendToClaude(state, 'T1');

      await runner.printed(/^The session on T1 ended \(exit code 3\)\./);
      await runner.printed(WAITING, 2);
      expect((await sendToClaude(state, 'T2')).status).toBe(200);
    });
  });

  describe('what it refuses, and says', () => {
    it('does not wait without claude in the PATH, so the board never promises a start', async () => {
      const { root, state } = await boardWithTasks();

      const runner = cliInBackground(['claude', '--wait'], {
        cwd: root,
        env: { PATH: await tmpDir() },
      });
      // It ends by itself, at once: a runner that waited here would be a promise it cannot keep.
      const run = await Promise.race([runner.done, refusedWithin(5_000)]);

      expect(run.exitCode).toBe(1);
      expect(run.err.join('\n')).toMatch(/`claude`.*PATH/);
      expect((await sendToClaude(state, 'T1')).status).toBe(409);
    });

    it('does not wait for a board that is not running', async () => {
      const claude = await fakeClaude();

      const runner = cliInBackground(['claude', '--wait'], {
        cwd: await tmpDir(),
        env: claude.env(),
      });
      const run = await Promise.race([runner.done, refusedWithin(5_000)]);

      expect(run.exitCode).toBe(1);
      expect(run.err.join('\n')).toContain('not running');
      expect(await claude.calls()).toEqual([]);
    });

    it('stops waiting when asked to, and the board no longer counts on it', async () => {
      const { root, state } = await boardWithTasks();
      const claude = await fakeClaude();
      const runner = cliInBackground(['claude', '--wait'], { cwd: root, env: claude.env() });
      await runner.printed(WAITING);

      const ended = await runner.stop();

      expect(ended.exitCode).toBe(0);
      expect((await sendToClaude(state, 'T1')).status).toBe(409);
      expect(await claude.calls()).toEqual([]);
    });
  });

  it('finds the board again when it was restarted, on its new address', async () => {
    const first = await boardWithTasks();
    const claude = await fakeClaude();
    const runner = cliInBackground(['claude', '--wait'], { cwd: first.root, env: claude.env() });
    await runner.printed(WAITING);

    await first.stop();
    await runner.printed(/^The board stopped; waiting for it to start again\./);
    const second = await boardWithTasks(first.root);
    await runner.printed(WAITING, 2);

    expect((await sendToClaude(second.state, 'T2')).status).toBe(200);
    const [call] = await callsOf(claude, 1);
    expect(call?.argv[call.argv.length - 1]).toBe(claudeCodePrompt('T2', boardUrl(second.state)));
  });
});
