import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeCodePrompt } from '../../src/contract/v1/index.js';
import { readRuntime, type RuntimeState } from '../../src/server/cli/runtime.js';
import { cli, stopBoards } from '../support/cli.js';
import { fakeClaude } from '../support/fakeClaude.js';
import { initRepo } from '../support/gitRepo.js';
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

/** A running board with two tasks: T1 and T2, so that "this task and not another" can be told. */
async function boardWithTasks(options: { git?: boolean } = {}): Promise<Started> {
  // A board outside a repository is rooted where it was started; inside one, at its top.
  const root = options.git === true ? await initRepo(await tmpDir()) : await tmpDir();
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

describe('local-project-board claude <id>', () => {
  describe('starting the session', () => {
    it('starts claude with the prompt of exactly this task, as its only argument (INVARIANT)', async () => {
      const { root, state } = await boardWithTasks();
      const claude = await fakeClaude();

      const run = await cli(['claude', 'T2'], { cwd: root, env: claude.env() });

      expect(run.exitCode).toBe(0);
      expect(run.err).toEqual([]);
      const calls = await claude.calls();
      // --session-id <uuid> <prompt>: exactly three arguments, the prompt last and whole.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.argv).toHaveLength(3);
      expect(calls[0]?.argv[0]).toBe('--session-id');
      expect(calls[0]?.argv[2]).toBe(claudeCodePrompt('T2', boardUrl(state)));
      expect(calls[0]?.argv[2]).toContain('/api/v1/tasks/T2/handoff');
      expect(calls[0]?.argv[2]).not.toContain('T1');
    });

    it('sends the session to a handoff that is the handoff of that task, as the board gives it', async () => {
      const { root, state } = await boardWithTasks();
      const claude = await fakeClaude();

      await cli(['claude', 'T2'], { cwd: root, env: claude.env() });

      const [call] = await claude.calls();
      const prompt = call?.argv[call.argv.length - 1] ?? '';
      const url = /read GET (\S+) and follow it/.exec(prompt)?.[1] ?? '';
      expect(url).toBe(`${boardUrl(state)}/api/v1/tasks/T2/handoff`);
      const handoff = await (await fetch(url)).text();
      expect(handoff).toContain('# Task T2: Write the report');
      expect(handoff).not.toContain('# Task T1: ');
    });

    it('starts it in the root of the project, wherever in the project it was typed', async () => {
      const { root } = await boardWithTasks({ git: true });
      const claude = await fakeClaude();
      const deeper = join(root, 'packages', 'app');
      await mkdir(deeper, { recursive: true });

      const run = await cli(['claude', 'T1'], { cwd: deeper, env: claude.env() });

      expect(run.exitCode).toBe(0);
      const [call] = await claude.calls();
      expect(await realpath(call?.cwd ?? '')).toBe(await realpath(root));
    });

    it('leaves the model, the permissions and the rest to claude itself', async () => {
      const { root } = await boardWithTasks();
      const claude = await fakeClaude();

      await cli(['claude', 'T1'], { cwd: root, env: claude.env() });

      const [call] = await claude.calls();
      // --session-id is the one flag the runner passes; no model/permission flags.
      expect(call?.argv.filter((a) => a.startsWith('-') && a !== '--session-id')).toEqual([]);
    });

    it('never gives the session token to claude: not in its arguments, not in its environment (INVARIANT)', async () => {
      const { root, state } = await boardWithTasks();
      const claude = await fakeClaude();

      const run = await cli(['claude', 'T1'], { cwd: root, env: claude.env() });

      expect(JSON.stringify(await claude.calls())).not.toContain(state.token);
      expect(run.text).not.toContain(state.token);
    });

    it('records the run on the board but does not move the task: the agent moves it (T33)', async () => {
      const { root, state } = await boardWithTasks();
      const claude = await fakeClaude();

      await cli(['claude', 'T1'], { cwd: root, env: claude.env() });

      const task = (await (await api(state, 'GET', '/tasks/T1')).json()) as {
        status?: string;
        aiRun?: { state?: string };
      };
      // Runner records the run end — aiRun is written — but the task status stays.
      expect(task.status).toBe('todo');
      expect(task.aiRun?.state).not.toBeUndefined();
    });
  });

  describe('the way it ends', () => {
    it('ends as claude ended: the exit code is passed on', async () => {
      const { root } = await boardWithTasks();
      const claude = await fakeClaude();

      const run = await cli(['claude', 'T1'], { cwd: root, env: claude.env({ exit: 7 }) });

      expect(run.exitCode).toBe(7);
      // Claude said what it had to say to the terminal itself; the board adds nothing.
      expect(run.err).toEqual([]);
    });

    it('ends as a shell would say for a claude that was killed by a signal', async () => {
      const { root } = await boardWithTasks();
      const claude = await fakeClaude();

      const run = await cli(['claude', 'T1'], {
        cwd: root,
        env: claude.env({ signal: 'SIGTERM' }),
      });

      expect(run.exitCode).toBe(143);
    });
  });

  describe('what it refuses, and says', () => {
    it('says that claude is not installed, and starts nothing (no claude in PATH)', async () => {
      const { root } = await boardWithTasks();
      const empty = await tmpDir();

      const run = await cli(['claude', 'T1'], { cwd: root, env: { PATH: empty } });

      expect(run.exitCode).toBe(1);
      expect(run.err.join('\n')).toMatch(/`claude`.*PATH/);
      expect(run.err.join('\n')).toContain('Claude Code');
    });

    it('does not take a file that is not executable for claude', async () => {
      const { root } = await boardWithTasks();
      const dir = await tmpDir();
      await writeFile(join(dir, 'claude'), 'not a program', { mode: 0o644 });

      const run = await cli(['claude', 'T1'], { cwd: root, env: { PATH: dir } });

      expect(run.exitCode).toBe(1);
      expect(run.err.join('\n')).toMatch(/`claude`.*PATH/);
    });

    it('says that the board is not running, and starts nothing', async () => {
      const root = await tmpDir();
      const claude = await fakeClaude();

      const run = await cli(['claude', 'T1'], { cwd: root, env: claude.env() });

      expect(run.exitCode).toBe(1);
      expect(run.err.join('\n')).toContain('not running');
      expect(run.err.join('\n')).toContain('npx local-project-board');
      expect(await claude.calls()).toEqual([]);
    });

    it('does not take the word of a runtime file whose board is gone', async () => {
      const { root, stop } = await boardWithTasks();
      await stop();
      const claude = await fakeClaude();

      const run = await cli(['claude', 'T1'], { cwd: root, env: claude.env() });

      expect(run.exitCode).toBe(1);
      expect(run.err.join('\n')).toContain('not running');
      expect(await claude.calls()).toEqual([]);
    });

    it('says which task does not exist, in the words of the board, and starts nothing', async () => {
      const { root } = await boardWithTasks();
      const claude = await fakeClaude();

      const run = await cli(['claude', 'T99'], { cwd: root, env: claude.env() });

      expect(run.exitCode).toBe(1);
      expect(run.err.join('\n')).toContain('Task "T99" does not exist.');
      expect(await claude.calls()).toEqual([]);
    });

    it('refuses what is not a task id before it looks at anything, and starts nothing (INVARIANT)', async () => {
      const { root } = await boardWithTasks();
      const claude = await fakeClaude();

      for (const id of ['banana', 'T1; touch pwned', '$(id)', 'T1 T2', '../T1', 't1']) {
        const run = await cli(['claude', id], { cwd: root, env: claude.env() });
        expect(run.exitCode).toBe(1);
        expect(run.err.join('\n')).toContain('is not a task id');
      }
      expect(await claude.calls()).toEqual([]);
    });

    it('is not a way to run anything else: the program is always `claude`', async () => {
      const { root } = await boardWithTasks();
      const claude = await fakeClaude();

      // PATH decides which `claude`; nothing on the command line names a program.
      const run = await cli(['claude', 'T1', 'ls'], { cwd: root, env: claude.env() });

      expect(run.exitCode).toBe(1);
      expect(run.err.join('\n')).toContain('Unexpected argument: ls');
      expect(await claude.calls()).toEqual([]);
    });
  });
});
