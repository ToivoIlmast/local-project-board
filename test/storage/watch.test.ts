import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isRuntimeFile,
  watchBoard,
  watchStrategyFor,
} from '../../src/server/storage/markdown/watch.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

afterEach(cleanTmpDirs);

/** `/proc/mounts` of a WSL2 machine, trimmed: the Windows drive is a 9p mount (T10). */
const WSL_MOUNTS = [
  'none /usr/lib/wsl/drivers 9p rw,nosuid,nodev,noatime,dirsync,aname=drivers 0 0',
  '/dev/sdc / ext4 rw,relatime,discard,errors=remount-ro,data=ordered 0 0',
  'C:\\134 /mnt/c 9p rw,noatime,dirsync,aname=drvfs;path=C:\\;uid=1000;gid=1000 0 0',
  'D:\\134 /mnt/d\\040drive drvfs rw,noatime 0 0',
  'tmpfs /mnt/c/cache tmpfs rw 0 0',
].join('\n');

describe('watchStrategyFor', () => {
  it('watches events on an ordinary Linux filesystem', () => {
    expect(watchStrategyFor('/home/me/project/.board', WSL_MOUNTS)).toBe('events');
  });

  it('polls on the Windows drive of WSL, where fs.watch reports nothing (T10)', () => {
    expect(watchStrategyFor('/mnt/c/Users/me/project/.board', WSL_MOUNTS)).toBe('poll');
    expect(watchStrategyFor('/mnt/c', WSL_MOUNTS)).toBe('poll');
  });

  it('reads a path with spaces, as /proc/mounts escapes them', () => {
    expect(watchStrategyFor('/mnt/c/Users/me/my project/.board', WSL_MOUNTS)).toBe('poll');
    expect(watchStrategyFor('/mnt/d drive/work/.board', WSL_MOUNTS)).toBe('poll');
  });

  it('takes the innermost mount, not the first prefix that matches', () => {
    expect(watchStrategyFor('/mnt/c/cache/.board', WSL_MOUNTS)).toBe('events');
  });

  it('does not take a sibling with the same prefix for the mount', () => {
    expect(watchStrategyFor('/mnt/cx/project/.board', WSL_MOUNTS)).toBe('events');
  });

  it('keeps events when the mounts cannot be read', () => {
    expect(watchStrategyFor('/mnt/c/project/.board', '')).toBe('events');
  });
});

describe('watchBoard by polling', () => {
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(changes: unknown[], count: number): Promise<void> {
    for (let i = 0; i < 100 && changes.length < count; i++) await settle(20);
  }

  async function polled(): Promise<{ dir: string; changes: number[]; stop: () => void }> {
    const dir = await tmpDir();
    await mkdir(join(dir, 'tasks', 'T1'), { recursive: true });
    await writeFile(join(dir, 'tasks', 'T1', 'task.md'), 'one\n', 'utf8');
    const changes: number[] = [];
    const controller = watchBoard(dir, () => changes.push(Date.now()), {
      strategy: 'poll',
      intervalMs: 20,
    });
    // The first scan only learns what is there; it reports nothing.
    await settle(150);
    return { dir, changes, stop: () => controller.abort() };
  }

  it('reports nothing while nothing changes', async () => {
    const { changes, stop } = await polled();
    await settle(200);
    stop();
    expect(changes).toEqual([]);
  });

  it('reports a task.md edited in place', async () => {
    const { dir, changes, stop } = await polled();
    await writeFile(join(dir, 'tasks', 'T1', 'task.md'), 'one, edited by hand\n', 'utf8');
    await waitFor(changes, 1);
    stop();
    expect(changes.length).toBeGreaterThan(0);
  });

  it('reports a new task in a new directory and a removed one', async () => {
    const { dir, changes, stop } = await polled();
    await mkdir(join(dir, 'tasks', 'T2'));
    await writeFile(join(dir, 'tasks', 'T2', 'task.md'), 'two\n', 'utf8');
    await waitFor(changes, 1);
    // Let the scan that saw T2 settle, so the removal is counted on its own.
    await settle(100);
    const afterCreate = changes.length;
    await rm(join(dir, 'tasks', 'T2'), { recursive: true });
    await waitFor(changes, afterCreate + 1);
    stop();
    expect(afterCreate).toBeGreaterThan(0);
    expect(changes.length).toBeGreaterThan(afterCreate);
  });

  it('does not report the runtime files of a running board', async () => {
    const { dir, changes, stop } = await polled();
    await writeFile(join(dir, 'runtime.json'), '{}\n', 'utf8');
    await mkdir(join(dir, 'runner'));
    await writeFile(join(dir, 'runner', 'T1.json'), '{}\n', 'utf8');
    await settle(200);
    stop();
    expect(changes).toEqual([]);
  });

  it('stops when aborted', async () => {
    const { dir, changes, stop } = await polled();
    stop();
    await writeFile(join(dir, 'tasks', 'T1', 'task.md'), 'after stop\n', 'utf8');
    await settle(200);
    expect(changes).toEqual([]);
  });

  it('survives a board directory that disappears and comes back', async () => {
    const { dir, changes, stop } = await polled();
    await rm(join(dir, 'tasks'), { recursive: true });
    await waitFor(changes, 1);
    const before = changes.length;
    await mkdir(join(dir, 'tasks', 'T3'), { recursive: true });
    await writeFile(join(dir, 'tasks', 'T3', 'task.md'), 'three\n', 'utf8');
    await waitFor(changes, before + 1);
    stop();
    expect(changes.length).toBeGreaterThan(before);
  });
});

describe('isRuntimeFile', () => {
  it('recognises runtime files with either path separator', () => {
    expect(isRuntimeFile('runner\\T1.json')).toBe(true);
    expect(isRuntimeFile('tasks\\T1\\task.md')).toBe(false);
  });
});
