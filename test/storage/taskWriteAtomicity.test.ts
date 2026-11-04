import { jest } from '@jest/globals';
import type * as fs from 'node:fs/promises';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BoardError } from '../../src/core/errors.js';
import type { TaskVersion } from '../../src/core/model/index.js';
import type { Storage } from '../../src/core/ports.js';
import { createTaskLocks } from '../../src/core/services/taskLocks.js';
import { createTaskService, type TaskService } from '../../src/core/services/tasks.js';
import { recordingEventSink, type RecordingEventSink } from '../support/events.js';
import { createMemoryStore, inMemoryStorage } from '../support/inMemoryStorage.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

/**
 * Files the markdown provider cannot replace, as on a disk that fails the write. Permissions
 * cannot do it: root writes through them. Every file is replaced by a rename onto it, so the
 * rename onto one of these fails; everything else goes to the real filesystem.
 */
const unwritable = new Set<string>();
jest.unstable_mockModule('node:fs/promises', () => {
  const actual = jest.requireActual<typeof fs>('node:fs/promises');
  const rename: typeof actual.rename = async (from, to) => {
    if (unwritable.has(String(to))) {
      throw Object.assign(new Error(`EIO: i/o error, rename '${String(to)}'`), { code: 'EIO' });
    }
    return actual.rename(from, to);
  };
  return { ...actual, rename, default: { ...actual, rename } };
});
// After the mock, so the provider writes through it.
const { markdownStorage } = await import('../../src/server/storage/markdown/index.js');

/**
 * A content PATCH that also names a place (T85, ADR-0030 §3): the check of the place, the sync
 * of the history and the write of the task are one section of the storage, so no write of the
 * board comes between them, and a PATCH that is refused leaves no version, no task and no event.
 * Every provider, through the service: the guarantee is the two of them together.
 */

interface Provider {
  storage: Storage;
  /** Everything the provider persists, to compare before and after a refusal. */
  state(): Promise<unknown>;
  /** Makes the next version of the task fail to be written, as a full disk would. */
  breakVersions(taskId: string): Promise<void>;
  /** Makes the task fail to be written; answers how to repair it. */
  breakTaskFile(taskId: string): Promise<() => Promise<void>>;
}

const providers: [string, () => Promise<Provider>][] = [
  [
    'in-memory',
    async () => {
      const store = createMemoryStore();
      return {
        storage: inMemoryStorage(store),
        // A read makes an empty history for the task; that is no write, so it is left out.
        state: async () =>
          JSON.stringify(store, (_key, value: unknown) =>
            value instanceof Map
              ? [...value].filter(
                  ([, entry]) =>
                    !(
                      entry !== null &&
                      typeof entry === 'object' &&
                      'versions' in entry &&
                      (entry as { versions: unknown[] }).versions.length === 0 &&
                      (entry as { checks: Map<unknown, unknown> }).checks.size === 0
                    ),
                )
              : value,
          ),
        breakVersions: async (taskId) => {
          const versions: TaskVersion[] = [];
          Object.freeze(versions);
          store.history.set(taskId, { versions, checks: new Map() });
        },
        breakTaskFile: async (taskId) => {
          const { tasks } = store;
          const set = tasks.set.bind(tasks);
          tasks.set = (id, task) => {
            if (id === taskId) throw new Error('The task cannot be written.');
            return set(id, task);
          };
          return async () => {
            tasks.set = set;
          };
        },
      };
    },
  ],
  [
    'markdown',
    async () => {
      const root = await tmpDir();
      const dir = join(root, '.board');
      return {
        storage: markdownStorage({ root }),
        state: async () => {
          const files: Record<string, string> = {};
          for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const path = join(entry.parentPath, entry.name);
            files[path.slice(dir.length + 1)] = await readFile(path, 'utf8');
          }
          return files;
        },
        // A file where the directory of the versions goes: it cannot be created.
        breakVersions: async (taskId) => {
          const history = join(dir, 'tasks', taskId, 'history');
          await mkdir(history, { recursive: true });
          await writeFile(join(history, 'versions'), 'not a directory\n', 'utf8');
        },
        // task.md cannot be replaced; its history is written as before.
        breakTaskFile: async (taskId) => {
          const file = join(dir, 'tasks', taskId, 'task.md');
          unwritable.add(file);
          return async () => {
            unwritable.delete(file);
          };
        },
      };
    },
  ],
];

/**
 * The storage as the service sees it, with `action` run the first time one of `methods` is
 * called and before it is: a concurrent write of the board landing exactly in that gap.
 */
function interleave(storage: Storage, methods: string[], action: () => Promise<unknown>): Storage {
  let fired = false;
  const wrapped: Record<string, unknown> = { ...storage };
  for (const method of methods) {
    const original = (storage as unknown as Record<string, unknown>)[method];
    if (typeof original !== 'function') continue;
    wrapped[method] = async (...args: unknown[]) => {
      if (!fired) {
        fired = true;
        await action();
      }
      return (original as (...a: unknown[]) => Promise<unknown>)(...args);
    };
  }
  return wrapped as unknown as Storage;
}

/** A write that never settles is a deadlock of the storage's queue; it fails here, not by hanging. */
async function settles<T>(action: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadlock = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('deadlock: the write never settled')), 2000);
  });
  try {
    return await Promise.race([action, deadlock]);
  } finally {
    clearTimeout(timer);
  }
}

async function code(action: Promise<unknown>): Promise<string> {
  return settles(action).then(
    () => 'no error',
    (error: unknown) => (error as BoardError).code ?? String(error),
  );
}

/** Before the sync reads the history, and before the write of the task: the gaps there were. */
const BEFORE_SYNC = ['listVersions'];
const BEFORE_WRITE = ['updateTask', 'updateTaskContent'];

describe.each(providers)('a content PATCH with a place, %s (T85, ADR-0030 §3)', (_name, make) => {
  const statuses = ['todo', 'done'];
  let provider: Provider;
  let storage: Storage;
  let events: RecordingEventSink;
  let tasks: TaskService;

  beforeEach(async () => {
    provider = await make();
    storage = provider.storage;
    await storage.init();
    events = recordingEventSink();
    tasks = createTaskService({ storage, events, statuses, locks: createTaskLocks() });
    await storage.createTopic({ title: 'first', body: '' });
    await storage.createBlock('P1', { title: 'one' });
  });

  afterEach(async () => {
    await storage.close();
    await cleanTmpDirs();
  });

  /** As an earlier board left it: content and no history, so a sync writes a `baseline`. */
  const legacy = () =>
    storage.createTask({ title: 'Legacy', status: 'todo', rank: 'a0', body: 'old\n', labels: [] });

  /** With history, then edited by hand: a sync writes an `external`. */
  async function editedOutside() {
    const task = await tasks.create({ title: 'Made here', body: 'one\n' });
    await storage.updateTask(task.id, { body: 'edited by hand\n' });
    events.events.length = 0;
    return (await storage.getTask(task.id))!;
  }

  const sources = async (id: string) =>
    (await storage.listVersions(id)).map((version) => version.source);

  /** A service whose storage lets `action` run at the gap named. */
  const racing = (methods: string[], action: () => Promise<unknown>): TaskService =>
    createTaskService({
      storage: interleave(storage, methods, action),
      events,
      statuses,
      locks: createTaskLocks(),
    });

  describe('A. a refused PATCH writes nothing (INVARIANT)', () => {
    it.each([
      ['a block the topic does not hold', { topic: 'P1', block: 'K9' }, 'INVALID_PLACEMENT'],
      ['a topic that does not exist', { topic: 'P9' }, 'INVALID_PLACEMENT'],
      ['a task that does not exist', { dependsOn: ['T99'] }, 'INVALID_DEPENDENCY'],
      ['itself', { dependsOn: ['T1'] }, 'DEPENDENCY_CYCLE'],
    ])('behind a baseline: %s', async (_case, place, expected) => {
      const task = await legacy();
      const before = await provider.state();
      expect(await code(tasks.update(task.id, { title: 'Renamed', body: 'new\n', ...place }))).toBe(
        expected,
      );
      expect(await provider.state()).toEqual(before);
      expect(events.events).toEqual([]);
    });

    it('behind an external version: a cycle', async () => {
      const task = await editedOutside();
      const other = await storage.createTask({
        title: 'Waits',
        status: 'todo',
        rank: 'a1',
        body: '',
        labels: [],
        dependsOn: [task.id],
      });
      const before = await provider.state();
      expect(await code(tasks.update(task.id, { body: 'mine\n', dependsOn: [other.id] }))).toBe(
        'DEPENDENCY_CYCLE',
      );
      expect(await provider.state()).toEqual(before);
      expect(events.events).toEqual([]);
    });

    it('refused by a precondition before the place is looked at', async () => {
      const task = await legacy();
      const before = await provider.state();
      expect(
        await code(
          tasks.update(task.id, { title: 'Renamed', topic: 'P1', ifContentHash: 'sha256:0' }),
        ),
      ).toBe('TASK_CONTENT_CHANGED');
      expect(await provider.state()).toEqual(before);
      expect(events.events).toEqual([]);
    });
  });

  describe('B. a PATCH into a block and the delete of the block', () => {
    it.each([
      ['before the sync', BEFORE_SYNC],
      ['before the write', BEFORE_WRITE],
    ])('the delete %s: refused, and no version left behind', async (_gap, methods) => {
      const task = await legacy();
      let deleted = 'not run';
      const service = racing(methods, async () => {
        deleted = await code(storage.deleteBlock('P1', 'K1'));
      });
      const patch = { title: 'Placed', topic: 'P1', block: 'K1' };
      expect(await code(service.update(task.id, patch))).toBe('INVALID_PLACEMENT');
      expect(deleted).toBe('no error');
      expect(await storage.getTask(task.id)).toEqual(task);
      expect(await storage.listVersions(task.id)).toEqual([]);
      expect(events.events).toEqual([]);
    });

    it('at the same time: one order or the other, never a version of a refused PATCH', async () => {
      const task = await legacy();
      const [write, remove] = await settles(
        Promise.allSettled([
          tasks.update(task.id, { title: 'Placed', topic: 'P1', block: 'K1' }),
          storage.deleteBlock('P1', 'K1'),
        ]),
      );
      if (write.status === 'fulfilled') {
        expect(remove.status === 'rejected' && (remove.reason as BoardError).code).toBe(
          'BLOCK_NOT_EMPTY',
        );
        expect(write.value).toMatchObject({ title: 'Placed', block: 'K1' });
        expect((await storage.getTopic('P1'))?.blocks.map((block) => block.id)).toEqual(['K1']);
        expect(await sources(task.id)).toEqual(['baseline', 'edit']);
      } else {
        expect((write.reason as BoardError).code).toBe('INVALID_PLACEMENT');
        expect(remove.status).toBe('fulfilled');
        expect(await storage.getTask(task.id)).toEqual(task);
        expect(await storage.listVersions(task.id)).toEqual([]);
        expect(events.events).toEqual([]);
      }
    });
  });

  describe('C. two writes that make a cycle together', () => {
    it.each([
      ['before the sync', BEFORE_SYNC],
      ['before the write', BEFORE_WRITE],
    ])('the other one %s is taken, and this one leaves nothing', async (_gap, methods) => {
      const a = await legacy();
      const b = await legacy();
      let other = 'not run';
      const service = racing(methods, async () => {
        other = await code(storage.updateTask(b.id, { dependsOn: [a.id] }));
      });
      expect(await code(service.update(a.id, { title: 'Waits', dependsOn: [b.id] }))).toBe(
        'DEPENDENCY_CYCLE',
      );
      expect(other).toBe('no error');
      expect(await storage.getTask(a.id)).toEqual(a);
      expect(await storage.listVersions(a.id)).toEqual([]);
      expect(events.events).toEqual([]);
    });

    it('at the same time: exactly one is taken, in some order', async () => {
      const a = await legacy();
      const b = await legacy();
      const results = await settles(
        Promise.allSettled([
          tasks.update(a.id, { title: 'Waits', dependsOn: [b.id] }),
          tasks.update(b.id, { body: 'waits too\n', dependsOn: [a.id] }),
        ]),
      );
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      const [taken, refused] = results[0].status === 'fulfilled' ? [a, b] : [b, a];
      const reason = (
        results.find((result) => result.status === 'rejected') as PromiseRejectedResult
      ).reason as BoardError;
      expect(reason.code).toBe('DEPENDENCY_CYCLE');
      expect(await sources(taken.id)).toEqual(['baseline', 'edit']);
      expect(await storage.getTask(refused.id)).toEqual(refused);
      expect(await storage.listVersions(refused.id)).toEqual([]);
    });
  });

  describe('D. a PATCH that is taken', () => {
    it('behind a baseline: baseline, then the edit, then the events in that order', async () => {
      const task = await legacy();
      const updated = await settles(
        tasks.update(task.id, { title: 'Placed', topic: 'P1', block: 'K1' }),
      );
      expect(updated).toMatchObject({ title: 'Placed', topic: 'P1', block: 'K1' });
      const versions = await storage.listVersions(task.id);
      expect(versions.map((version) => [version.number, version.source])).toEqual([
        [1, 'baseline'],
        [2, 'edit'],
      ]);
      expect(versions[0]?.snapshot).toEqual({ title: 'Legacy', body: 'old\n', labels: [] });
      expect(versions[1]).toMatchObject({ changed: ['title'], snapshot: { title: 'Placed' } });
      expect(events.events).toEqual([
        { type: 'version.created', taskId: task.id, number: 1 },
        { type: 'version.created', taskId: task.id, number: 2 },
        { type: 'task.updated', task: updated },
      ]);
      expect(await storage.getTask(task.id)).toEqual(updated);
    });

    it('behind a change made outside: create, external, edit', async () => {
      const task = await editedOutside();
      const dependency = await legacy();
      const updated = await settles(
        tasks.update(task.id, { title: 'Now', dependsOn: [dependency.id], topic: 'P1' }),
      );
      expect(updated).toMatchObject({ title: 'Now', dependsOn: [dependency.id], topic: 'P1' });
      const versions = await storage.listVersions(task.id);
      expect(versions.map((version) => [version.number, version.source, version.changed])).toEqual([
        [1, 'create', []],
        [2, 'external', ['body']],
        [3, 'edit', ['title']],
      ]);
      expect(versions[1]?.snapshot.body).toBe('edited by hand\n');
      expect(versions[2]?.snapshot).toEqual({ title: 'Now', body: 'edited by hand\n', labels: [] });
      expect(events.types()).toEqual(['version.created', 'version.created', 'task.updated']);
    });
  });

  describe('E. the sync cannot be written', () => {
    it('leaves the task as it was, and announces nothing', async () => {
      const task = await legacy();
      await provider.breakVersions(task.id);
      const before = await provider.state();
      const failed = await code(
        tasks.update(task.id, { title: 'Placed', topic: 'P1', block: 'K1' }),
      );
      expect(failed).not.toBe('no error');
      expect(failed).not.toMatch(/deadlock/);
      expect(await storage.getTask(task.id)).toEqual(task);
      expect(await provider.state()).toEqual(before);
      expect(events.events).toEqual([]);
    });
  });

  describe('G. the task cannot be written after the sync was (a known limit)', () => {
    it('keeps the sync, appends no edit, and announces nothing', async () => {
      const task = await legacy();
      const repair = await provider.breakTaskFile(task.id);
      const failed = await code(
        tasks.update(task.id, { title: 'Placed', topic: 'P1', block: 'K1' }),
      );
      await repair();
      expect(failed).not.toBe('no error');
      expect(failed).not.toMatch(/deadlock/);
      expect(await storage.getTask(task.id)).toEqual(task);
      // Append-only: the baseline is the content as it still is, and is not taken back.
      expect(await sources(task.id)).toEqual(['baseline']);
      expect(events.events).toEqual([]);
    });
  });

  describe('F. no deadlock', () => {
    it('a taken PATCH with a sync settles, and the storage takes writes after it', async () => {
      const task = await legacy();
      await settles(tasks.update(task.id, { body: 'b\n', topic: 'P1', block: 'K1' }));
      await settles(tasks.update(task.id, { body: 'c\n', topic: null, block: null }));
      expect(await sources(task.id)).toEqual(['baseline', 'edit', 'edit']);
      const next = await settles(tasks.create({ title: 'After' }));
      expect(await settles(storage.deleteBlock('P1', 'K1'))).toBeUndefined();
      expect(await sources(next.id)).toEqual(['create']);
    });
  });
});
