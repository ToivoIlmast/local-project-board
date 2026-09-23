import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readRuntime, runtimePath } from '../../src/server/cli/runtime.js';
import { cli, deadPid, stopBoards } from '../support/cli.js';
import { boardAnswersAt, freePort, occupyPort, releasePorts } from '../support/ports.js';
import { cleanTmpDirs, tmpDir, writeYaml } from '../support/tmp.js';

afterEach(async () => {
  await stopBoards();
  await releasePorts();
  await cleanTmpDirs();
});

/** The runtime state of a board that was started and then killed without cleaning up. */
async function writeStaleRuntime(root: string, port = 1): Promise<void> {
  await mkdir(join(root, '.board'), { recursive: true });
  await writeFile(
    runtimePath(root),
    JSON.stringify({
      formatVersion: 1,
      pid: await deadPid(),
      port,
      url: `http://127.0.0.1:${port}/`,
      token: 'the-token-of-a-board-that-is-gone',
      root,
    }),
    'utf8',
  );
}

/**
 * How many directory watchers this process holds. A board that gave up has to close the
 * storage it opened, and the watcher is the part of it that can be seen from outside.
 */
async function openWatchers(): Promise<number> {
  const count = (): number =>
    process.getActiveResourcesInfo().filter((resource) => resource === 'FSEventWrap').length;
  for (let attempt = 0; attempt < 20 && count() > 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return count();
}

describe('a board that cannot start', () => {
  it('reports a broken configuration by key, value and source', async () => {
    const root = await tmpDir();
    await writeYaml(root, 'board.config.yaml', 'server: { port: 0 }\n');

    const run = await cli([], { cwd: root });

    expect(run.exitCode).toBe(1);
    expect(run.err.join('\n')).toContain('config.server.port');
    expect(run.err.join('\n')).toContain('board.config.yaml');
    expect(await readRuntime(root)).toEqual({ kind: 'missing' });
    expect(run.opened).toEqual([]);
  });

  it('names the flag when the flag is what is wrong', async () => {
    const run = await cli(['--port', 'abc'], { cwd: await tmpDir() });

    expect(run.exitCode).toBe(1);
    expect(run.err.join('\n')).toContain('--port');
  });

  it('lists the providers it has when the configured one does not exist', async () => {
    const root = await tmpDir();
    await writeYaml(root, 'board.config.yaml', 'storage: { provider: postgres }\n');

    const run = await cli([], { cwd: root });

    expect(run.exitCode).toBe(1);
    expect(run.err.join('\n')).toContain('Unknown storage provider. Available: markdown');
    expect(await readRuntime(root)).toEqual({ kind: 'missing' });
  });

  it('refuses to hide tasks whose status was removed from the config (INVARIANT)', async () => {
    const root = await tmpDir();
    const first = await cli(['--no-open'], { cwd: root });
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');
    await fetch(`${runtime.state.url}api/v1/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${runtime.state.token}`,
      },
      body: JSON.stringify({ title: 'in review', status: 'in-progress' }),
    });
    await first.stop?.();
    await writeYaml(root, 'board.config.yaml', 'statuses: [backlog, done]\n');

    const second = await cli(['--no-open'], { cwd: root });

    expect(second.exitCode).toBe(1);
    expect(second.err.join('\n')).toContain('in-progress');
    expect(second.err.join('\n')).toContain('T1');
    // The board never began serving, and it left no runtime state behind.
    expect(await readRuntime(root)).toEqual({ kind: 'missing' });
  });

  it('leaves behind no runtime state at all when it gives up, not even a stale one (INVARIANT)', async () => {
    const root = await tmpDir();
    const first = await cli(['--no-open'], { cwd: root });
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');
    await fetch(`${runtime.state.url}api/v1/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${runtime.state.token}`,
      },
      body: JSON.stringify({ title: 'a task in a status that is about to go', status: 'todo' }),
    });
    await first.stop?.();
    // A board that was killed leaves this behind; the next start must not leave it lying.
    await writeStaleRuntime(root);
    await writeYaml(root, 'board.config.yaml', 'statuses: [backlog, done]\n');

    const second = await cli(['--no-open'], { cwd: root });

    expect(second.exitCode).toBe(1);
    expect(await readRuntime(root)).toEqual({ kind: 'missing' });
  });

  it('closes the board files it opened before giving up (INVARIANT)', async () => {
    const root = await tmpDir();
    const first = await cli(['--no-open'], { cwd: root });
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');
    await fetch(`${runtime.state.url}api/v1/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${runtime.state.token}`,
      },
      body: JSON.stringify({ title: 'a task in a status that is about to go', status: 'todo' }),
    });
    await first.stop?.();
    await writeYaml(root, 'board.config.yaml', 'statuses: [backlog, done]\n');

    const second = await cli(['--no-open'], { cwd: root });

    expect(second.exitCode).toBe(1);
    expect(await openWatchers()).toBe(0);
  });

  it('starts when the recorded port answers, but not as a board', async () => {
    const root = await tmpDir();
    // Something else took the port the board used to have, and it is not friendly.
    const port = await occupyPort(404);
    await writeStaleRuntime(root, port);

    const run = await cli(['--no-open'], { cwd: root });

    expect(run.exitCode).toBe(0);
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');
    expect(runtime.state.port).not.toBe(port);
    expect(await boardAnswersAt(runtime.state.url, root)).toBe(true);
  });

  it('gives up its port again when it cannot write its runtime state', async () => {
    const root = await tmpDir();
    const port = await freePort();
    // A directory where the runtime file belongs: the board listens, then cannot record it.
    await mkdir(runtimePath(root), { recursive: true });

    const run = await cli(['--port', String(port), '--no-open'], { cwd: root });

    expect(run.exitCode).toBe(1);
    expect(await boardAnswersAt(`http://127.0.0.1:${port}/`, root)).toBe(false);
    // The port is free again, so the next attempt can have it.
    const second = await cli(['--port', String(port), '--no-open'], { cwd: await tmpDir() });
    expect(second.exitCode).toBe(0);
  });

  it('fails on a port the user asked for and something else holds', async () => {
    const root = await tmpDir();
    const busy = await occupyPort();

    const run = await cli(['--port', String(busy), '--no-open'], { cwd: root });

    expect(run.exitCode).toBe(1);
    expect(run.err.join('\n')).toContain(`Port ${busy} is already in use.`);
    expect(await readRuntime(root)).toEqual({ kind: 'missing' });
  });

  it('leaves no server listening behind when it gives up', async () => {
    const root = await tmpDir();
    const port = await freePort();
    await writeYaml(root, 'board.config.yaml', 'statuses: [backlog, todo]\n');
    await writeFile(join(root, '.board'), 'not a directory\n', 'utf8');

    const run = await cli(['--port', String(port), '--no-open'], { cwd: root });

    expect(run.exitCode).toBe(1);
    expect(await boardAnswersAt(`http://127.0.0.1:${port}/`, root)).toBe(false);
  });

  it('says what is wrong with a damaged runtime file instead of starting a second board', async () => {
    const root = await tmpDir();
    await mkdir(join(root, '.board'), { recursive: true });
    await writeFile(runtimePath(root), '{ this is not json', 'utf8');

    const run = await cli(['--no-open'], { cwd: root });

    expect(run.exitCode).toBe(1);
    expect(run.err.join('\n')).toContain(runtimePath(root));
    expect(run.err.join('\n')).toMatch(/delete/i);
  });

  it('will not start a second board on a board that is already running (INVARIANT)', async () => {
    const root = await tmpDir();
    await cli(['--no-open'], { cwd: root });
    const before = await readRuntime(root);
    if (before.kind !== 'state') throw new Error('unreachable');

    const second = await cli(['--no-open'], { cwd: root });

    expect(second.exitCode).toBe(1);
    expect(second.err.join('\n')).toContain(before.state.url);
    expect(second.err.join('\n')).not.toContain(before.state.token);
    // The board that is running keeps its own runtime state.
    expect(await readRuntime(root)).toEqual(before);
    expect((await fetch(`${before.state.url}api/v1/tasks`)).status).toBe(200);
  });

  it('explains itself without a stack trace and without the token (INVARIANT)', async () => {
    const root = await tmpDir();
    await cli(['--no-open'], { cwd: root });
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');

    const failures = [
      await cli(['--no-open'], { cwd: root }),
      await cli(['--port', '70000', '--no-open'], { cwd: await tmpDir() }),
      await cli(['--nonsense'], { cwd: await tmpDir() }),
    ];

    for (const run of failures) {
      expect(run.exitCode).toBe(1);
      expect(run.err.join('\n')).not.toMatch(/\.ts:\d+:\d+|\n\s+at\s/);
      expect(run.text).not.toContain(runtime.state.token);
      expect(run.err.join('\n').length).toBeGreaterThan(0);
    }
  });

  it('prints the usage when the command line makes no sense', async () => {
    const run = await cli(['start'], { cwd: await tmpDir() });

    expect(run.exitCode).toBe(1);
    expect(run.err.join('\n')).toContain('Unknown command: start');
    expect(run.err.join('\n')).toContain('local-project-board');
  });

  it('answers --help with the usage and success', async () => {
    const run = await cli(['--help'], { cwd: await tmpDir() });

    expect(run.exitCode).toBe(0);
    expect(run.out.join('\n')).toContain('instructions');
    expect(run.err).toEqual([]);
  });
});
