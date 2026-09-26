import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readRuntime, type RuntimeState } from '../../src/server/cli/runtime.js';
import { cli, stopBoards } from '../support/cli.js';
import { freePort, releasePorts } from '../support/ports.js';
import { cleanTmpDirs, tmpDir, writeYaml } from '../support/tmp.js';

afterEach(async () => {
  await stopBoards();
  await releasePorts();
  await cleanTmpDirs();
});

/** Talks to a running board the way any client would: token and all. */
async function api(
  state: RuntimeState,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
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

/** A board with a task T1 in `todo`, an override of the board and one of the column. */
async function boardWithTask(): Promise<Started> {
  const root = await tmpDir();
  // Not the port of the configuration, so a handoff that never asked the board shows it.
  const start = await cli(['--port', String(await freePort()), '--no-open'], { cwd: root });
  const runtime = await readRuntime(root);
  if (runtime.kind !== 'state') throw new Error('unreachable');
  const state = runtime.state;
  expect(
    (
      await api(state, 'POST', '/tasks', {
        title: 'Extract the git adapter',
        status: 'todo',
        body: '## Context\n\nThe parser is in HTTP.\n',
      })
    ).status,
  ).toBe(201);
  expect(
    (await api(state, 'PUT', '/tasks/T1/documents/plan.md', { content: '# Plan\n' })).status,
  ).toBe(200);
  expect(
    (
      await api(state, 'PUT', '/workflow', {
        board: { push: true, checkCommand: 'npm test' },
        statuses: { todo: { commit: false } },
      })
    ).status,
  ).toBe(200);
  return { root, state, stop: () => start.stop?.() ?? Promise.resolve() };
}

/**
 * Everything on disk under the board, with the time it was written. The one exception is the
 * `.gitignore` that every storage `init()` writes again with the same content, `export` too.
 */
async function tree(root: string): Promise<[string, string, number][]> {
  const files: [string, string, number][] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const time = entry.name === '.gitignore' ? 0 : (await stat(path)).mtimeMs;
        files.push([path, await readFile(path, 'utf8'), time]);
      }
    }
  };
  await walk(root);
  return files.sort();
}

/** Only the origin differs between a board that is running and one that is not. */
const withoutOrigin = (text: string): string =>
  text.replace(/http:\/\/127\.0\.0\.1:\d+/g, 'ORIGIN');

describe('local-project-board handoff <id>', () => {
  describe('with the board running', () => {
    it('prints what the running board itself answers (INVARIANT)', async () => {
      const { root, state } = await boardWithTask();

      const run = await cli(['handoff', 'T1'], { cwd: root });

      expect(run.exitCode).toBe(0);
      expect(run.err).toEqual([]);
      const served = await (await fetch(`${state.url}api/v1/tasks/T1/handoff`)).text();
      expect(run.out.join('\n').trim()).toBe(served.trim());
      expect(run.out.join('\n')).toContain('# Task T1: Extract the git adapter');
      expect(run.out.join('\n')).toContain('Push your commits');
      expect(run.out.join('\n')).toContain('Do not commit');
      expect(run.out.join('\n')).toContain('`npm test`');
    });

    it('carries no token, although this board knows one (INVARIANT)', async () => {
      const { root, state } = await boardWithTask();

      const run = await cli(['handoff', 'T1'], { cwd: root });

      expect(run.text).not.toContain(state.token);
      expect(run.out.join('\n')).toContain('Authorization: Bearer <session token>');
      expect(run.out.join('\n')).toContain(`Base URL: http://127.0.0.1:${state.port}/api/v1`);
    });

    it('follows a change of the settings made after the last handoff', async () => {
      const { root, state } = await boardWithTask();
      expect((await cli(['handoff', 'T1'], { cwd: root })).text).toContain('Push your commits');

      await api(state, 'PUT', '/workflow', { board: {}, statuses: {} });

      expect((await cli(['handoff', 'T1'], { cwd: root })).text).toContain('Do not push');
    });
  });

  describe('without the board running', () => {
    it('reads the board from disk and carries no token (INVARIANT)', async () => {
      const { root, state, stop } = await boardWithTask();
      await stop();
      await writeYaml(root, 'board.config.yaml', 'server: { port: 7502 }\n');

      const run = await cli(['handoff', 'T1'], { cwd: root });

      expect(run.exitCode).toBe(0);
      const text = run.out.join('\n');
      expect(text).toContain('# Task T1: Extract the git adapter');
      expect(text).toContain('The parser is in HTTP.');
      expect(text).toContain('`plan.md`');
      expect(text).toContain('Push your commits');
      expect(text).toContain('Do not commit');
      expect(text).toContain('source: column "todo"');
      expect(text).toContain('Authorization: Bearer <session token>');
      expect(text).toContain('Base URL: http://127.0.0.1:7502/api/v1');
      expect(run.text).not.toContain(state.token);
      // It describes the task; it does not start a board.
      expect(await readRuntime(root)).toEqual({ kind: 'missing' });
    });

    it('does not take the word of a runtime file whose board is gone (INVARIANT)', async () => {
      const { root, state, stop } = await boardWithTask();
      await stop();

      const run = await cli(['handoff', 'T1'], { cwd: root });

      expect(run.exitCode).toBe(0);
      expect(run.text).not.toContain(state.token);
      expect(run.out.join('\n')).toContain('<session token>');
    });

    it('follows the ai.rules of board.config.yaml', async () => {
      const { root, stop } = await boardWithTask();
      await stop();
      await writeYaml(
        root,
        'board.config.yaml',
        'ai:\n  rules:\n    - Ask before renaming a task.\n',
      );

      const run = await cli(['handoff', 'T1'], { cwd: root });

      expect(run.out.join('\n')).toContain('- Ask before renaming a task.');
    });

    it('is the same text as the running board gives, apart from the origin (INVARIANT)', async () => {
      const { root, stop } = await boardWithTask();
      const online = await cli(['handoff', 'T1'], { cwd: root });
      await stop();

      const offline = await cli(['handoff', 'T1'], { cwd: root });

      expect(offline.exitCode).toBe(0);
      expect(withoutOrigin(offline.out.join('\n'))).toBe(withoutOrigin(online.out.join('\n')));
    });

    it('reads a hand edit of .board/workflow.yaml', async () => {
      const { root, stop } = await boardWithTask();
      await stop();
      await writeYaml(
        join(root, '.board'),
        'workflow.yaml',
        'formatVersion: 1\nboard:\n  push: false\n',
      );

      const run = await cli(['handoff', 'T1'], { cwd: root });

      expect(run.out.join('\n')).toContain('Do not push');
      expect(run.out.join('\n')).not.toContain('Push your commits');
    });
  });

  describe('it only reads', () => {
    it('leaves every file of the board as it was, offline and online (INVARIANT)', async () => {
      const { root, stop } = await boardWithTask();
      const online = await tree(join(root, '.board'));
      await cli(['handoff', 'T1'], { cwd: root });
      await cli(['handoff', 'T99'], { cwd: root });
      expect(await tree(join(root, '.board'))).toEqual(online);
      await stop();

      const offline = await tree(join(root, '.board'));
      await cli(['handoff', 'T1'], { cwd: root });
      await cli(['handoff', 'T99'], { cwd: root });

      expect(await tree(join(root, '.board'))).toEqual(offline);
    });
  });

  describe('failures', () => {
    const failures: [string, string[]][] = [
      ['a task that is not on the board', ['handoff', 'T99']],
      ['an id that no task can have', ['handoff', 'banana']],
      ['no id at all', ['handoff']],
      ['too many ids', ['handoff', 'T1', 'T2']],
    ];

    it.each(failures)(
      'says what is wrong and exits with 1 when it is given %s, offline',
      async (_name, argv) => {
        const { root, state, stop } = await boardWithTask();
        await stop();

        const run = await cli(argv, { cwd: root });

        expect(run.exitCode).toBe(1);
        expect(run.out).toEqual([]);
        expect(run.err.join('\n').length).toBeGreaterThan(0);
        expect(run.err.join('\n')).not.toMatch(/\.ts:\d+:\d+|\n\s+at\s/);
        expect(run.text).not.toContain(state.token);
      },
    );

    it.each(failures)(
      'says what is wrong and exits with 1 when it is given %s, online',
      async (_name, argv) => {
        const { root, state } = await boardWithTask();

        const run = await cli(argv, { cwd: root });

        expect(run.exitCode).toBe(1);
        expect(run.out).toEqual([]);
        expect(run.err.join('\n').length).toBeGreaterThan(0);
        expect(run.err.join('\n')).not.toMatch(/\.ts:\d+:\d+|\n\s+at\s/);
        expect(run.text).not.toContain(state.token);
      },
    );

    it('names the task that is missing, in the same words either way', async () => {
      const { root, stop } = await boardWithTask();
      const online = await cli(['handoff', 'T99'], { cwd: root });
      await stop();
      const offline = await cli(['handoff', 'T99'], { cwd: root });

      expect(online.err.join('\n')).toContain('T99');
      expect(offline.err.join('\n')).toBe(online.err.join('\n'));
    });

    it('names an id that no task can have, and what ids look like', async () => {
      const { root } = await boardWithTask();

      const run = await cli(['handoff', 'banana'], { cwd: root });

      expect(run.err.join('\n')).toContain('banana');
      expect(run.err.join('\n')).toContain('T1');
    });

    it('asks for the id, and shows the usage, when there is none', async () => {
      const run = await cli(['handoff'], { cwd: await tmpDir() });

      expect(run.err.join('\n')).toContain('needs the id of a task');
      expect(run.err.join('\n')).toContain('handoff <id>');
    });

    it('does not start a board or create one for a directory that has none', async () => {
      const root = await tmpDir();

      const run = await cli(['handoff', 'T1'], { cwd: root });

      expect(run.exitCode).toBe(1);
      expect(await readRuntime(root)).toEqual({ kind: 'missing' });
    });
  });
});
