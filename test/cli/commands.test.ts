import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { API_RULES } from '../../src/contract/v1/index.js';
import { boardSnapshotSchema } from '../../src/core/model/snapshot.js';
import { readRuntime, runtimePath, type RuntimeState } from '../../src/server/cli/runtime.js';
import { cli, deadPid, stopBoards } from '../support/cli.js';
import { releasePorts } from '../support/ports.js';
import { cleanTmpDirs, tmpDir, writeYaml } from '../support/tmp.js';

afterEach(async () => {
  await stopBoards();
  await releasePorts();
  await cleanTmpDirs();
});

/** Creates a task on a running board, the way any client would. */
async function createTask(url: string, token: string, title: string): Promise<void> {
  const response = await fetch(`${url}api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ title }),
  });
  expect(response.status).toBe(201);
}

describe('local-project-board instructions', () => {
  it('hands out what the running board itself answers, token and all (INVARIANT)', async () => {
    const root = await tmpDir();
    await cli(['--no-open'], { cwd: root });
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');

    const run = await cli(['instructions'], { cwd: root });

    expect(run.exitCode).toBe(0);
    const served = await (await fetch(`${runtime.state.url}api/v1/instructions`)).text();
    expect(run.out.join('\n').trim()).toBe(served.trim());
    expect(run.out.join('\n')).toContain(`Authorization: Bearer ${runtime.state.token}`);
    expect(run.out.join('\n')).toContain(`Base URL: http://127.0.0.1:${runtime.state.port}/api/v1`);
  });

  it('works without a board running, and then carries no token (INVARIANT)', async () => {
    const root = await tmpDir();
    await writeYaml(
      root,
      'board.config.yaml',
      'project: { name: offline-board }\nstatuses: [idea, done]\nserver: { port: 7500 }\n',
    );

    const run = await cli(['instructions'], { cwd: root });

    expect(run.exitCode).toBe(0);
    const text = run.out.join('\n');
    expect(text).toContain('<session token>');
    expect(text).toContain('/api/v1/session');
    expect(text).toContain('idea, done');
    expect(text).toContain('offline-board');
    expect(text).toContain('Base URL: http://127.0.0.1:7500/api/v1');
    // It describes the board; it does not start one.
    expect(await readRuntime(root)).toEqual({ kind: 'missing' });
  });

  it('adds the ai.rules of board.config.yaml to the API rules, never in place of them (INVARIANT)', async () => {
    const root = await tmpDir();
    await writeYaml(
      root,
      'board.config.yaml',
      'ai:\n  rules:\n    - Ask before renaming a task.\n',
    );

    const run = await cli(['instructions'], { cwd: root });

    expect(run.exitCode).toBe(0);
    const text = run.out.join('\n');
    expect(text).toContain('### Project rules');
    expect(text).toContain('- Ask before renaming a task.');
    for (const rule of API_RULES) expect(text).toContain(`- ${rule}`);
  });

  it('gives the API rules and no project rules to a board that configures none', async () => {
    const root = await tmpDir();

    const run = await cli(['instructions'], { cwd: root });

    const text = run.out.join('\n');
    for (const rule of API_RULES) expect(text).toContain(`- ${rule}`);
    expect(text).not.toContain('### Project rules');
  });

  it('refuses the removed ai.allowSourceEdits and says what to use instead, and starts nothing', async () => {
    const root = await tmpDir();
    await writeYaml(root, 'board.config.yaml', 'ai:\n  allowSourceEdits: false\n');

    for (const args of [['instructions'], ['handoff', 'T1'], ['--no-open']]) {
      const run = await cli(args, { cwd: root });

      expect(run.exitCode).toBe(1);
      const text = run.err.join('\n');
      expect(text).toContain('config.ai.allowSourceEdits');
      expect(text).toContain('editCode');
      expect(text).toContain('.board/workflow.yaml');
      expect(text).toContain('board.config.yaml');
    }
    expect(await readRuntime(root)).toEqual({ kind: 'missing' });
  });

  it('does not take the word of a runtime file whose board is gone (INVARIANT)', async () => {
    const root = await tmpDir();
    const start = await cli(['--no-open'], { cwd: root });
    const before = await readRuntime(root);
    if (before.kind !== 'state') throw new Error('unreachable');
    const stale: RuntimeState = { ...before.state, pid: await deadPid() };
    await start.stop?.();
    // Exactly what a killed board leaves behind: a file that still names a port and a token.
    await writeFile(runtimePath(root), JSON.stringify(stale), 'utf8');

    const run = await cli(['instructions'], { cwd: root });

    expect(run.exitCode).toBe(0);
    expect(run.out.join('\n')).not.toContain(stale.token);
    expect(run.out.join('\n')).toContain('<session token>');
  });

  it('never hands out the instructions of another board (INVARIANT)', async () => {
    const other = await tmpDir();
    const mine = await tmpDir();
    await cli(['--no-open'], { cwd: other });
    const theirs = await readRuntime(other);
    if (theirs.kind !== 'state') throw new Error('unreachable');
    // My board left a runtime file behind, and another board now answers on that port.
    await mkdir(join(mine, '.board'), { recursive: true });
    await writeFile(runtimePath(mine), JSON.stringify({ ...theirs.state, root: mine }), 'utf8');

    const run = await cli(['instructions'], { cwd: mine });

    expect(run.exitCode).toBe(0);
    expect(run.out.join('\n')).not.toContain(theirs.state.token);
    expect(run.out.join('\n')).toContain('<session token>');
  });

  it('prints offline instructions after the board was stopped', async () => {
    const root = await tmpDir();
    const run = await cli(['--no-open'], { cwd: root });
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');
    const token = runtime.state.token;
    await run.stop?.();
    // A board that was killed would leave this file behind; instructions must not quote
    // a token that no longer opens anything.
    await writeYaml(root, 'board.config.yaml', 'server: { port: 7501 }\n');

    const offline = await cli(['instructions'], { cwd: root });

    expect(offline.exitCode).toBe(0);
    expect(offline.out.join('\n')).not.toContain(token);
    expect(offline.out.join('\n')).toContain('<session token>');
  });

  it('is the same text either way, apart from what only a running board knows', async () => {
    const root = await tmpDir();
    const offline = await cli(['instructions'], { cwd: root });
    await cli(['--no-open'], { cwd: root });
    const online = await cli(['instructions'], { cwd: root });

    for (const heading of ['## Authentication', '## Rules', '## Errors', '### GET /api/v1/tasks']) {
      expect(offline.out.join('\n')).toContain(heading);
      expect(online.out.join('\n')).toContain(heading);
    }
  });
});

describe('local-project-board export', () => {
  it('writes a snapshot of everything on the board', async () => {
    const root = await tmpDir();
    const start = await cli(['--no-open'], { cwd: root });
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');
    await createTask(runtime.state.url, runtime.state.token, 'exported task');
    await fetch(`${runtime.state.url}api/v1/tasks/T1/documents/plan.md`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${runtime.state.token}`,
      },
      body: JSON.stringify({ content: '# Plan\n' }),
    });
    await start.stop?.();

    const file = join(root, 'snapshot.json');
    const run = await cli(['export', '--out', file], { cwd: root });

    expect(run.exitCode).toBe(0);
    const snapshot = boardSnapshotSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    expect(snapshot.tasks).toMatchObject([{ id: 'T1', title: 'exported task' }]);
    expect(snapshot.documents).toMatchObject([{ taskId: 'T1', name: 'plan.md' }]);
    expect(run.out.join('\n')).toContain(file);
  });

  it('prints the snapshot when it is not told where to put it', async () => {
    const root = await tmpDir();

    const run = await cli(['export'], { cwd: root });

    expect(run.exitCode).toBe(0);
    const snapshot = boardSnapshotSchema.parse(JSON.parse(run.out.join('\n')));
    expect(snapshot).toMatchObject({
      formatVersion: 2,
      workflow: { board: {}, statuses: {} },
      tasks: [],
      documents: [],
      reports: [],
    });
  });

  it('exports a board that is running, without disturbing it', async () => {
    const root = await tmpDir();
    await cli(['--no-open'], { cwd: root });
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');
    await createTask(runtime.state.url, runtime.state.token, 'still running');

    const run = await cli(['export'], { cwd: root });

    expect(run.exitCode).toBe(0);
    expect(boardSnapshotSchema.parse(JSON.parse(run.out.join('\n'))).tasks).toHaveLength(1);
    expect(await readRuntime(root)).toEqual(runtime);
    expect((await fetch(`${runtime.state.url}api/v1/tasks`)).status).toBe(200);
  });

  it('reports a snapshot it cannot write, and does not pretend it succeeded', async () => {
    const root = await tmpDir();

    const run = await cli(['export', '--out', join(root, 'missing', 'snapshot.json')], {
      cwd: root,
    });

    expect(run.exitCode).toBe(1);
    expect(run.err.join('\n')).toContain('snapshot.json');
  });
});
