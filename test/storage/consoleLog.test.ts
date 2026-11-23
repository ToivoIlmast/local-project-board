import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BoardError } from '../../src/core/errors.js';
import type { ConsoleJournalEntry, ConsoleRunRef, Storage } from '../../src/core/ports.js';
import { markdownStorage } from '../../src/server/storage/markdown/index.js';
import { createMemoryStore, inMemoryStorage } from '../support/inMemoryStorage.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

/**
 * The console journal of a run, as the Storage port describes it (plan C7, §9.1): append and
 * read, in the order written, kept across a reopen. One suite for every provider (ADR-0004).
 */

interface Harness {
  name: string;
  create(): Promise<Storage>;
  reopen(storage: Storage): Promise<Storage>;
  /** Adds bytes to the end of the journal of a run, as a process that died mid-write would. */
  appendRaw?(storage: Storage, run: ConsoleRunRef, text: string): Promise<void>;
  /** The journal file of a run, when the provider has one. */
  fileOf?(storage: Storage, run: ConsoleRunRef): string;
}

const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';
const AT = '2026-09-21T09:00:00.000Z';

const entry = (seq: number, over: Partial<ConsoleJournalEntry> = {}): ConsoleJournalEntry => ({
  seq,
  at: AT,
  source: 'runner',
  runnerSeq: seq,
  event: { kind: 'process.started', pid: seq },
  ...over,
});

const memoryStores = new Map<Storage, ReturnType<typeof createMemoryStore>>();
const markdownRoots = new Map<Storage, string>();

const harnesses: Harness[] = [
  {
    name: 'markdown',
    create: async () => {
      const root = await tmpDir();
      const storage = markdownStorage({ root });
      markdownRoots.set(storage, root);
      return storage;
    },
    reopen: async (previous) => {
      const root = markdownRoots.get(previous)!;
      const storage = markdownStorage({ root });
      markdownRoots.set(storage, root);
      return storage;
    },
    fileOf: (storage, run) =>
      join(markdownRoots.get(storage)!, '.board', 'console', `${run.taskId}-${run.runId}.ndjson`),
    appendRaw: async (storage, run, text) => {
      const file = join(
        markdownRoots.get(storage)!,
        '.board',
        'console',
        `${run.taskId}-${run.runId}.ndjson`,
      );
      await writeFile(file, text, { encoding: 'utf8', flag: 'a' });
    },
  },
  {
    name: 'in-memory',
    create: async () => {
      const store = createMemoryStore();
      const storage = inMemoryStorage(store);
      memoryStores.set(storage, store);
      return storage;
    },
    reopen: async (previous) => {
      const store = memoryStores.get(previous)!;
      const storage = inMemoryStorage(store);
      memoryStores.set(storage, store);
      return storage;
    },
  },
];

afterAll(cleanTmpDirs);

describe.each(harnesses)('ConsoleLog conformance: $name', (harness) => {
  let storage: Storage;
  const opened: Storage[] = [];
  let run: ConsoleRunRef;

  async function open(provider?: Storage): Promise<Storage> {
    const next = provider ?? (await harness.create());
    await next.init();
    opened.push(next);
    return next;
  }

  beforeEach(async () => {
    storage = await open();
    const task = await storage.createTask({
      title: 'Console',
      status: 'todo',
      rank: 'a0',
      body: '',
      labels: [],
    });
    run = { taskId: task.id, runId: 1, sessionId: SESSION };
  });

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((provider) => provider.close()));
  });

  it('reads nothing from a run that has no journal (INVARIANT)', async () => {
    await expect(storage.readConsole(run.taskId, 1)).resolves.toEqual([]);
  });

  it('reads back what was appended, in order, without a header (INVARIANT)', async () => {
    await storage.appendConsole(run, [entry(1), entry(2)]);
    await storage.appendConsole(run, [
      entry(3, { source: 'server', event: { kind: 'compat.passed' } }),
    ]);
    const read = await storage.readConsole(run.taskId, 1);
    expect(read.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(read[2]).toEqual(entry(3, { source: 'server', event: { kind: 'compat.passed' } }));
  });

  it('writes nothing for an empty append, not even a journal', async () => {
    await storage.appendConsole(run, []);
    await expect(storage.readConsole(run.taskId, 1)).resolves.toEqual([]);
    if (harness.fileOf) await expect(stat(harness.fileOf(storage, run))).rejects.toThrow();
  });

  it('keeps the journals of two runs apart', async () => {
    await storage.appendConsole(run, [entry(1)]);
    await storage.appendConsole({ ...run, runId: 2 }, [entry(1), entry(2)]);
    expect(await storage.readConsole(run.taskId, 1)).toHaveLength(1);
    expect(await storage.readConsole(run.taskId, 2)).toHaveLength(2);
  });

  it('keeps the journal across a reopen of the provider (INVARIANT)', async () => {
    await storage.appendConsole(run, [entry(1), entry(2)]);
    await storage.close();
    const next = await open(await harness.reopen(storage));
    expect((await next.readConsole(run.taskId, 1)).map((item) => item.seq)).toEqual([1, 2]);
    await next.appendConsole(run, [entry(3)]);
    expect((await next.readConsole(run.taskId, 1)).map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it('refuses a task that does not exist and writes nothing', async () => {
    await expect(storage.appendConsole({ ...run, taskId: 'T99' }, [entry(1)])).rejects.toThrow(
      BoardError,
    );
    await expect(storage.readConsole('T99', 1)).rejects.toThrow(BoardError);
  });

  it('is gone with the task', async () => {
    await storage.appendConsole(run, [entry(1)]);
    await storage.deleteTask(run.taskId);
    if (harness.fileOf) await expect(stat(harness.fileOf(storage, run))).rejects.toThrow();
  });

  it('keeps entries whole when appends run at once (INVARIANT)', async () => {
    const appends = Array.from({ length: 20 }, (_, index) =>
      storage.appendConsole(run, [
        entry(index + 1, { event: { kind: 'process.started', pid: 7 } }),
      ]),
    );
    await Promise.all(appends);
    const read = await storage.readConsole(run.taskId, 1);
    expect(read).toHaveLength(20);
  });

  if (harness.appendRaw !== undefined) {
    const raw = harness.appendRaw;

    it('leaves out a line that was torn by a crash and goes on after it', async () => {
      await storage.appendConsole(run, [entry(1)]);
      await raw(storage, run, '{"seq":2,"at":"2026-09-21T09:00:00.000Z","sour');
      expect((await storage.readConsole(run.taskId, 1)).map((item) => item.seq)).toEqual([1]);
      await storage.appendConsole(run, [entry(2)]);
      expect((await storage.readConsole(run.taskId, 1)).map((item) => item.seq)).toEqual([1, 2]);
    });
  }

  if (harness.fileOf !== undefined) {
    const fileOf = harness.fileOf;

    it('writes a header first, then one JSON line per entry (INVARIANT)', async () => {
      await storage.appendConsole(run, [entry(1), entry(2)]);
      const lines = (await readFile(fileOf(storage, run), 'utf8')).trimEnd().split('\n');
      expect(JSON.parse(lines[0]!)).toEqual({
        seq: 0,
        header: { formatVersion: 1, taskId: run.taskId, runId: 1, sessionId: SESSION },
      });
      expect(lines.slice(1).map((line) => (JSON.parse(line) as { seq: number }).seq)).toEqual([
        1, 2,
      ]);
    });

    it('does not write the header again on a later append', async () => {
      await storage.appendConsole(run, [entry(1)]);
      await storage.appendConsole(run, [entry(2)]);
      const text = await readFile(fileOf(storage, run), 'utf8');
      expect(text.match(/"header"/g)).toHaveLength(1);
    });

    it('skips a line of the journal that is not an entry', async () => {
      await storage.appendConsole(run, [entry(1)]);
      await writeFile(fileOf(storage, run), 'not json\n{"seq":"x"}\n', { flag: 'a' });
      await storage.appendConsole(run, [entry(2)]);
      expect((await storage.readConsole(run.taskId, 1)).map((item) => item.seq)).toEqual([1, 2]);
    });
  }
});
