import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isBoardAlive,
  readRuntime,
  removeRuntime,
  runtimePath,
  writeRuntime,
  type RuntimeState,
} from '../../src/server/cli/runtime.js';
import { createTestBoard } from '../support/httpBoard.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

afterEach(cleanTmpDirs);

function state(root: string, port = 7432): RuntimeState {
  return {
    formatVersion: 1,
    pid: process.pid,
    port,
    url: `http://127.0.0.1:${port}/`,
    token: 'a-token',
    root,
  };
}

describe('.board/runtime.json', () => {
  it('lives in the board directory and is written for this user only', async () => {
    const root = await tmpDir();
    await mkdir(join(root, '.board'), { recursive: true });

    await writeRuntime(state(root));

    expect(runtimePath(root)).toBe(join(root, '.board', 'runtime.json'));
    const mode = (await stat(runtimePath(root))).mode & 0o777;
    // It holds the session token, so the group and the world may not read it.
    expect(mode & 0o077).toBe(0);
    expect(mode & 0o600).toBe(0o600);
  });

  it('holds what is needed to find the board, and nothing else (INVARIANT)', async () => {
    const root = await tmpDir();
    await mkdir(join(root, '.board'), { recursive: true });

    await writeRuntime(state(root, 7500));

    const parsed: unknown = JSON.parse(await readFile(runtimePath(root), 'utf8'));
    expect(Object.keys(parsed as object).sort()).toEqual(
      ['formatVersion', 'pid', 'port', 'root', 'token', 'url'].sort(),
    );
    expect(parsed).toMatchObject({ port: 7500, url: 'http://127.0.0.1:7500/', root });
  });

  it('is read back as it was written', async () => {
    const root = await tmpDir();
    await mkdir(join(root, '.board'), { recursive: true });
    await writeRuntime(state(root));

    expect(await readRuntime(root)).toEqual({ kind: 'state', state: state(root) });
  });

  it('reports a board that was never started as missing', async () => {
    expect(await readRuntime(await tmpDir())).toEqual({ kind: 'missing' });
  });

  it('reports a damaged file as unreadable instead of guessing (INVARIANT)', async () => {
    const root = await tmpDir();
    await mkdir(join(root, '.board'), { recursive: true });

    for (const content of ['{', '', 'null', '[]', '{"pid":1}', '{"port":"x"}']) {
      await writeFile(runtimePath(root), content, 'utf8');
      expect(await readRuntime(root)).toEqual({ kind: 'unreadable', file: runtimePath(root) });
    }
  });

  it('is removed on request, and removing what is not there is not an error', async () => {
    const root = await tmpDir();
    await mkdir(join(root, '.board'), { recursive: true });
    await writeRuntime(state(root));

    await removeRuntime(root);
    expect(await readRuntime(root)).toEqual({ kind: 'missing' });
    await expect(removeRuntime(root)).resolves.toBeUndefined();
  });
});

describe('deciding whether the board it describes is still running', () => {
  it('says no when nothing answers on the recorded port', async () => {
    const root = await tmpDir();
    // Port 1 on the loopback interface: refused at once, so this is not a slow test.
    expect(await isBoardAlive(state(root, 1))).toBe(false);
  });

  it('says yes when the board itself answers', async () => {
    const board = await createTestBoard();
    try {
      expect(
        await isBoardAlive({
          ...state(board.root, board.port),
          url: `${board.origin}/`,
        }),
      ).toBe(true);
    } finally {
      await board.close();
    }
  });

  it('says no when the port was taken over by another board (INVARIANT)', async () => {
    const board = await createTestBoard();
    try {
      // Same port, different board root: this runtime file is stale, not alive.
      expect(
        await isBoardAlive({
          ...state(await tmpDir(), board.port),
          url: `${board.origin}/`,
        }),
      ).toBe(false);
    } finally {
      await board.close();
    }
  });
});
