import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readRuntime, runtimePath } from '../../src/server/cli/runtime.js';
import { cli, deadPid, stopBoards } from '../support/cli.js';
import { repoWithCommit } from '../support/gitRepo.js';
import { freePort, occupyPort, releasePorts } from '../support/ports.js';
import { cleanTmpDirs, tmpDir, writeYaml } from '../support/tmp.js';

afterEach(async () => {
  await stopBoards();
  await releasePorts();
  await cleanTmpDirs();
});

/** The runtime state of a board that was started and then killed without cleaning up. */
async function writeStaleRuntime(root: string): Promise<void> {
  await mkdir(join(root, '.board'), { recursive: true });
  await writeFile(
    runtimePath(root),
    JSON.stringify({
      formatVersion: 1,
      pid: await deadPid(),
      port: 1,
      url: 'http://127.0.0.1:1/',
      token: 'the-token-of-a-board-that-is-gone',
      root,
    }),
    'utf8',
  );
}

describe('starting the board', () => {
  it('serves the API and says where', async () => {
    const root = await tmpDir();

    const run = await cli([], { cwd: root });

    expect(run.exitCode).toBe(0);
    const url = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(run.out.join('\n'))?.[1] ?? '';
    expect(url).not.toBe('');
    const project = await (await fetch(`${url}api/v1/project`)).json();
    expect(project).toMatchObject({ root, storage: { provider: 'markdown' } });
  });

  it('writes the runtime state of the board that is really listening (INVARIANT)', async () => {
    const root = await tmpDir();

    const run = await cli([], { cwd: root });
    const runtime = await readRuntime(root);

    expect(runtime.kind).toBe('state');
    if (runtime.kind !== 'state') throw new Error('unreachable');
    expect(runtime.state).toMatchObject({ formatVersion: 1, pid: process.pid, root });
    expect(runtime.state.url).toBe(`http://127.0.0.1:${runtime.state.port}/`);
    expect(run.out.join('\n')).toContain(runtime.state.url);

    // The token in the file is the one the running server accepts, and no other.
    const created = await fetch(`${runtime.state.url}api/v1/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${runtime.state.token}`,
      },
      body: JSON.stringify({ title: 'created with the token from runtime.json' }),
    });
    expect(created.status).toBe(201);
  });

  it('opens the browser on the port it really bound, and only if asked', async () => {
    const root = await tmpDir();

    const opening = await cli([], { cwd: root });
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');
    expect(opening.opened).toEqual([runtime.state.url]);

    const quiet = await cli(['--no-open'], { cwd: await tmpDir() });
    expect(quiet.opened).toEqual([]);
  });

  it('puts the board at the repository root, wherever it was started from', async () => {
    const root = await repoWithCommit(await tmpDir());
    const nested = join(root, 'src', 'deep');
    await mkdir(nested, { recursive: true });

    await cli(['--no-open'], { cwd: nested });

    expect((await readRuntime(root)).kind).toBe('state');
    expect((await readRuntime(nested)).kind).toBe('missing');
  });

  it('is configured by the file, the environment and the flags, in that order', async () => {
    const root = await tmpDir();
    await writeYaml(
      root,
      'board.config.yaml',
      'project: { name: from-file }\nstatuses: [idea, doing, shipped]\ntasks: { idPrefix: F }\n',
    );
    const envPort = await freePort();
    const flagPort = await freePort();

    const run = await cli(['--port', String(flagPort), '--no-open'], {
      cwd: root,
      env: { BOARD_PORT: String(envPort), BOARD_PROJECT_NAME: 'from-env' },
    });

    expect(run.exitCode).toBe(0);
    const project = await (await fetch(`http://127.0.0.1:${flagPort}/api/v1/project`)).json();
    expect(project).toMatchObject({
      name: 'from-env',
      statuses: ['idea', 'doing', 'shipped'],
      idPrefix: 'F',
    });
  });

  it('chooses the next free port when the configured one is taken', async () => {
    const root = await tmpDir();
    const busy = await occupyPort();

    const run = await cli([], { cwd: root, env: { BOARD_PORT: String(busy) } });

    expect(run.exitCode).toBe(0);
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');
    expect(runtime.state.port).toBeGreaterThan(busy);
    expect((await fetch(`${runtime.state.url}api/v1/tasks`)).status).toBe(200);
    // Not the port that was asked for: the browser is opened on the one that answers.
    expect(run.opened).toEqual([runtime.state.url]);
  });

  it('replaces the runtime state of a board that is no longer there', async () => {
    const root = await tmpDir();
    await writeStaleRuntime(root);

    const run = await cli(['--no-open'], { cwd: root });

    expect(run.exitCode).toBe(0);
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');
    expect(runtime.state.token).not.toBe('the-token-of-a-board-that-is-gone');
    expect(runtime.state.pid).toBe(process.pid);
  });

  it('gives a new token on every start, and the old one stops working (INVARIANT)', async () => {
    const root = await tmpDir();
    const first = await cli(['--no-open'], { cwd: root });
    const before = await readRuntime(root);
    if (before.kind !== 'state') throw new Error('unreachable');
    await first.stop?.();

    await cli(['--no-open'], { cwd: root });
    const after = await readRuntime(root);
    if (after.kind !== 'state') throw new Error('unreachable');

    expect(after.state.token).not.toBe(before.state.token);
    const withOldToken = await fetch(`${after.state.url}api/v1/tasks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${before.state.token}`,
      },
      body: JSON.stringify({ title: 'with the token of the previous run' }),
    });
    expect(withOldToken.status).toBe(401);
  });

  it('never prints the token (INVARIANT)', async () => {
    const root = await tmpDir();
    const run = await cli([], { cwd: root });
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');

    await run.stop?.();
    expect(run.text).not.toContain(runtime.state.token);
    expect(run.opened.join('\n')).not.toContain(runtime.state.token);
  });
});
