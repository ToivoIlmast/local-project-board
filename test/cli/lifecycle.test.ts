import { readRuntime } from '../../src/server/cli/runtime.js';
import { cli, stopBoards } from '../support/cli.js';
import { boardAnswersAt, releasePorts } from '../support/ports.js';
import { openStream } from '../support/sse.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

afterEach(async () => {
  await stopBoards();
  await releasePorts();
  await cleanTmpDirs();
});

describe('stopping the board', () => {
  it('stops answering and takes its runtime state with it (INVARIANT)', async () => {
    const root = await tmpDir();
    const run = await cli(['--no-open'], { cwd: root });
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');
    expect(await boardAnswersAt(runtime.state.url, root)).toBe(true);

    await run.stop?.();

    expect(await boardAnswersAt(runtime.state.url, root)).toBe(false);
    expect(await readRuntime(root)).toEqual({ kind: 'missing' });
  });

  it('does not wait for an open event stream (INVARIANT)', async () => {
    const root = await tmpDir();
    const run = await cli(['--no-open'], { cwd: root });
    const runtime = await readRuntime(root);
    if (runtime.kind !== 'state') throw new Error('unreachable');
    const stream = await openStream(runtime.state.port, '/api/v1/events');

    // An open tab must not hold the board open: this would hang without closeServer().
    await run.stop?.();

    expect(await readRuntime(root)).toEqual({ kind: 'missing' });
    stream.close();
  });

  it('can be stopped twice, as two signals in a row would', async () => {
    const root = await tmpDir();
    const run = await cli(['--no-open'], { cwd: root });

    await run.stop?.();
    await expect(run.stop?.()).resolves.toBeUndefined();
  });

  it('leaves the board it cannot claim alone', async () => {
    const root = await tmpDir();
    const first = await cli(['--no-open'], { cwd: root });
    const before = await readRuntime(root);

    const refused = await cli(['--no-open'], { cwd: root });
    expect(refused.exitCode).toBe(1);

    // The failed start must not have removed the runtime state of the running board.
    expect(await readRuntime(root)).toEqual(before);
    await first.stop?.();
    expect(await readRuntime(root)).toEqual({ kind: 'missing' });
  });
});
