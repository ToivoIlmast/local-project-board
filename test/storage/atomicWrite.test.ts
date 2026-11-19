import { jest } from '@jest/globals';
import type * as fs from 'node:fs/promises';
import { open, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

/**
 * T105: replacing a file on Windows while something has it open. `rename` is `MoveFileExW`
 * there, and it refuses to replace a target that any handle is open on — even a reader that
 * shares delete, as every Node reader does — with EPERM (measured on Windows 10 19045). The
 * board reads task files outside the write queue, so its own reader can be that handle. A temp
 * file opened without delete sharing (an antivirus scan, the indexer) makes the rename EBUSY.
 *
 * The faults are injected where they happen, at `rename`; everything else is the real disk.
 * Each entry of `faults` fails one rename with that code, then the real rename runs again.
 */
const faults: string[] = [];
const renames: { from: string; to: string }[] = [];
jest.unstable_mockModule('node:fs/promises', () => {
  const actual = jest.requireActual<typeof fs>('node:fs/promises');
  const rename: typeof actual.rename = async (from, to) => {
    renames.push({ from: String(from), to: String(to) });
    const code = faults.shift();
    if (code !== undefined) {
      throw Object.assign(new Error(`${code}: injected, rename '${String(to)}'`), { code });
    }
    return actual.rename(from, to);
  };
  return { ...actual, rename, default: { ...actual, rename } };
});
// After the mock, so the write goes through it.
const { writeFileAtomic } = await import('../../src/server/storage/markdown/atomic.js');

let root: string;
let file: string;

beforeEach(async () => {
  faults.length = 0;
  renames.length = 0;
  root = await tmpDir();
  file = join(root, 'task.md');
  await writeFile(file, 'original\n', 'utf8');
  renames.length = 0;
});

afterEach(async () => {
  faults.length = 0;
  await cleanTmpDirs();
});

const leftovers = async (): Promise<string[]> =>
  (await readdir(root)).filter((name) => name.endsWith('.tmp'));

describe('writeFileAtomic on Windows: a target or temp file held for a moment', () => {
  const win32 = { platform: 'win32' } as const;

  it.each(['EPERM', 'EBUSY'])(
    'a passing %s: the write lands, nothing is left behind',
    async (code) => {
      faults.push(code, code);

      await writeFileAtomic(file, 'new\n', win32);

      expect(await readFile(file, 'utf8')).toBe('new\n');
      expect(await leftovers()).toEqual([]);
      // The same temp file each time: the content is written once, only the replace is repeated.
      expect(renames).toHaveLength(3);
      expect(new Set(renames.map((r) => r.from)).size).toBe(1);
    },
  );

  it('a lasting EPERM: fails with that EPERM, in bounded time, the original intact', async () => {
    faults.push(...Array<string>(1000).fill('EPERM'));
    const started = Date.now();

    await expect(writeFileAtomic(file, 'new\n', win32)).rejects.toMatchObject({ code: 'EPERM' });

    expect(Date.now() - started).toBeLessThan(3000);
    expect(renames.length).toBeGreaterThan(1);
    expect(renames.length).toBeLessThan(20);
    expect(await readFile(file, 'utf8')).toBe('original\n');
    expect(await leftovers()).toEqual([]);
  });

  it.each(['EACCES', 'EIO', 'ENOSPC', 'EXDEV', 'EISDIR'])(
    'any other error (%s) is not retried: it fails at once, the original intact',
    async (code) => {
      faults.push(code);

      await expect(writeFileAtomic(file, 'new\n', win32)).rejects.toMatchObject({ code });

      expect(renames).toHaveLength(1);
      expect(await readFile(file, 'utf8')).toBe('original\n');
      expect(await leftovers()).toEqual([]);
    },
  );

  it('a write with nothing in the way replaces once, without waiting', async () => {
    await writeFileAtomic(file, 'new\n', win32);

    expect(renames).toHaveLength(1);
    expect(await readFile(file, 'utf8')).toBe('new\n');
  });
});

describe('writeFileAtomic on Linux and macOS: no rename failure is a passing one', () => {
  // There an open file never blocks a rename: EPERM is a sticky directory or an immutable file,
  // EBUSY a mount point. Waiting would only delay the same error.
  it.each([
    ['linux', 'EPERM'],
    ['linux', 'EBUSY'],
    ['darwin', 'EPERM'],
    ['darwin', 'EBUSY'],
  ] as const)('%s: %s fails at once, the original intact', async (platform, code) => {
    faults.push(code);

    await expect(writeFileAtomic(file, 'new\n', { platform })).rejects.toMatchObject({ code });

    expect(renames).toHaveLength(1);
    expect(await readFile(file, 'utf8')).toBe('original\n');
    expect(await leftovers()).toEqual([]);
  });
});

// The real thing: an open handle on the target, no injected fault.
const onWindows = process.platform === 'win32' ? describe : describe.skip;
onWindows('writeFileAtomic on this Windows: a real reader holding the target', () => {
  it('a reader that lets go in a moment does not fail the write', async () => {
    const reader = await open(file, 'r');
    const released = new Promise((resolve) => setTimeout(resolve, 60)).then(() => reader.close());

    await writeFileAtomic(file, 'new\n');
    await released;

    expect(await readFile(file, 'utf8')).toBe('new\n');
    expect(await leftovers()).toEqual([]);
  });

  it('a reader that never lets go: EPERM, the original intact, the temp file removed', async () => {
    const reader = await open(file, 'r');
    try {
      await expect(writeFileAtomic(file, 'new\n')).rejects.toMatchObject({ code: 'EPERM' });
    } finally {
      await reader.close();
    }

    expect(await readFile(file, 'utf8')).toBe('original\n');
    expect(await leftovers()).toEqual([]);
  });

  it('a reader polling the file, as a client polls the board: every write lands', async () => {
    let reading = true;
    const poller = (async () => {
      while (reading) {
        await readFile(file, 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();

    try {
      for (let i = 0; i < 100; i++) await writeFileAtomic(file, `v${i}\n`);
    } finally {
      reading = false;
      await poller;
    }

    expect(await readFile(file, 'utf8')).toBe('v99\n');
    expect(await leftovers()).toEqual([]);
  }, 30_000);
});
