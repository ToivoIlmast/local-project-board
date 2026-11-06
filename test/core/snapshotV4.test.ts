import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BoardError } from '../../src/core/errors.js';
import { boardSnapshotSchema } from '../../src/core/model/index.js';
import type { Storage } from '../../src/core/ports.js';
import { createSnapshot } from '../../src/core/services/snapshot.js';
import { markdownStorage } from '../../src/server/storage/markdown/index.js';
import { createMemoryStore, inMemoryStorage } from '../support/inMemoryStorage.js';
import { restoreSnapshot } from '../support/restoreSnapshot.js';
import { cleanTmpDirs, tmpDir } from '../support/tmp.js';

const project = { name: 'dep-health', statuses: ['todo', 'done'], idPrefix: 'T' };

const v3Fixture = (): Promise<unknown> =>
  readFile(new URL('./fixtures/snapshot-v3.json', import.meta.url), 'utf8').then(
    (text) => JSON.parse(text) as unknown,
  );

const opened: Storage[] = [];

async function board(root?: string): Promise<{ root: string; storage: Storage }> {
  const dir = root ?? (await tmpDir());
  const storage = markdownStorage({ root: dir });
  await storage.init();
  opened.push(storage);
  return { root: dir, storage };
}

/** What the export says, as a file would hold it: through JSON and back. */
async function exported(storage: Storage): Promise<unknown> {
  return JSON.parse(JSON.stringify(await createSnapshot(storage, project))) as unknown;
}

const newTask = (title: string) => ({ title, status: 'todo', rank: 'a0', body: '', labels: [] });

/** P1 [K1, K2], P2 [K3], P3 [] and T1 in P1/K2, T2 in P2/K3, T3 in P1 with no block. */
async function fill(storage: Storage): Promise<void> {
  const p1 = await storage.createTopic({ title: 'M1 Core', body: '## Goal\n\nShip it.\n' });
  await storage.createBlock(p1.id, { title: 'Storage' });
  await storage.createBlock(p1.id, { title: 'API' });
  const p2 = await storage.createTopic({ title: 'Revalidation', body: '' });
  await storage.createBlock(p2.id, { title: 'Trigger' });
  await storage.createTopic({ title: 'Later', body: 'Nothing yet.\n' });
  await storage.createTask({ ...newTask('Write the port'), topic: 'P1', block: 'K2' });
  await storage.createTask({ ...newTask('Write the trigger'), topic: 'P2', block: 'K3' });
  await storage.createTask({ ...newTask('Plan'), topic: 'P1', dependsOn: ['T1'] });
}

/** Every id a test has seen issued, so a new one can be checked against all of them. */
const issued = (topics: { id: string; blocks: { id: string }[] }[]): string[] =>
  topics.flatMap((topic) => [topic.id, ...topic.blocks.map((block) => block.id)]);

afterEach(async () => {
  await Promise.all(opened.splice(0).map((storage) => storage.close()));
});
afterAll(cleanTmpDirs);

describe('export v3 is still read (ADR-0032 §10, INVARIANT)', () => {
  it('reads an export written by the board before T87, unchanged', async () => {
    const v3 = await v3Fixture();
    expect(v3).toMatchObject({ formatVersion: 3 });
    expect(boardSnapshotSchema.parse(v3)).toEqual(v3);
  });

  it('reads it as before: no topics and no counters are asked of it', async () => {
    const v3 = (await v3Fixture()) as Record<string, unknown>;
    expect(v3).not.toHaveProperty('topics');
    expect(v3).not.toHaveProperty('sequence');
    // A v3 task may name a topic it does not hold: v3 says nothing of topics.
    expect(JSON.stringify(v3.tasks)).toContain('"topic":"P1"');
    expect(boardSnapshotSchema.safeParse(v3).success).toBe(true);
  });

  it('still refuses what v3 refused: a field v3 does not have', async () => {
    const v3 = (await v3Fixture()) as Record<string, unknown>;
    expect(boardSnapshotSchema.safeParse({ ...v3, topics: [] }).success).toBe(false);
    expect(boardSnapshotSchema.safeParse({ ...v3, tasks: 'none' }).success).toBe(false);
  });

  it('refuses a version it does not know', async () => {
    const v3 = (await v3Fixture()) as Record<string, unknown>;
    expect(boardSnapshotSchema.safeParse({ ...v3, formatVersion: 2 }).success).toBe(false);
    expect(boardSnapshotSchema.safeParse({ ...v3, formatVersion: 5 }).success).toBe(false);
  });
});

describe('export v4: tasks, topics with blocks, and the counters (ADR-0032 §10)', () => {
  it('holds formatVersion 4, every task, every topic with its blocks in order, and the counters', async () => {
    const { storage } = await board();
    await fill(storage);
    await storage.reorderBlocks('P1', ['K2', 'K1']);

    const snapshot = await createSnapshot(storage, project);

    expect(boardSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.formatVersion).toBe(4);
    expect(snapshot.tasks).toEqual(await storage.listTasks());
    expect(snapshot.tasks.map((task) => [task.id, task.topic, task.block])).toEqual([
      ['T1', 'P1', 'K2'],
      ['T2', 'P2', 'K3'],
      ['T3', 'P1', undefined],
    ]);
    expect(snapshot.topics).toEqual([
      {
        id: 'P1',
        title: 'M1 Core',
        body: '## Goal\n\nShip it.\n',
        blocks: [
          { id: 'K2', title: 'API' },
          { id: 'K1', title: 'Storage' },
        ],
      },
      { id: 'P2', title: 'Revalidation', body: '', blocks: [{ id: 'K3', title: 'Trigger' }] },
      { id: 'P3', title: 'Later', body: 'Nothing yet.\n', blocks: [] },
    ]);
    expect(snapshot.sequence).toEqual({ topicSequence: 3, blockSequence: 3 });
  });

  it('resolves every topic and block a task names within the export (INVARIANT)', async () => {
    const { storage } = await board();
    await fill(storage);
    const snapshot = await createSnapshot(storage, project);
    const topics = new Map(snapshot.topics.map((topic) => [topic.id, topic]));
    const placed = snapshot.tasks.filter((task) => task.topic !== undefined);
    expect(placed).toHaveLength(3);
    for (const task of placed) {
      const topic = topics.get(task.topic as string);
      expect(topic).toBeDefined();
      if (task.block !== undefined) {
        expect(topic?.blocks.map((block) => block.id)).toContain(task.block);
      }
    }
  });

  it('exports an empty board: no tasks, no topics, no counters', async () => {
    const { storage } = await board();
    const snapshot = await createSnapshot(storage, project);
    expect(boardSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toMatchObject({ formatVersion: 4, tasks: [], topics: [], sequence: null });
  });

  it('exports a board with tasks and no topics', async () => {
    const { storage } = await board();
    await storage.createTask(newTask('One'));
    await storage.createTask(newTask('Two'));
    const snapshot = await createSnapshot(storage, project);
    expect(boardSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.tasks.map((task) => task.id)).toEqual(['T1', 'T2']);
    expect(snapshot.topics).toEqual([]);
    expect(snapshot.sequence).toBeNull();
  });

  it('exports the counters through the in-memory provider too', async () => {
    const storage = inMemoryStorage(createMemoryStore());
    await storage.init();
    await fill(storage);
    const snapshot = await createSnapshot(storage, project);
    expect(snapshot.topics.map((topic) => topic.id)).toEqual(['P1', 'P2', 'P3']);
    expect(snapshot.sequence).toEqual({ topicSequence: 3, blockSequence: 3 });
  });

  describe('a backup never refers to a topic or a block it does not hold (fail-closed, INVARIANT)', () => {
    async function refused(storage: Storage, text: string): Promise<void> {
      const result = createSnapshot(storage, project);
      await expect(result).rejects.toThrow(BoardError);
      await result.catch((error: unknown) => {
        expect((error as BoardError).code).toBe('INVALID_PLACEMENT');
        expect((error as BoardError).message).toContain(text);
      });
    }

    it('refuses to export a task in a topic whose topic.md cannot be read', async () => {
      const { root, storage } = await board();
      await fill(storage);
      await writeFile(join(root, '.board/topics/P2/topic.md'), 'no frontmatter\n', 'utf8');
      await refused(storage, 'T2');
    });

    it('refuses to export a task whose topic was removed by hand', async () => {
      const store = createMemoryStore();
      const storage = inMemoryStorage(store);
      await storage.init();
      await fill(storage);
      store.topics.delete('P2');
      await refused(storage, 'P2');
    });

    it('refuses to export a task whose block its topic no longer holds', async () => {
      const store = createMemoryStore();
      const storage = inMemoryStorage(store);
      await storage.init();
      await fill(storage);
      const p1 = store.topics.get('P1');
      if (!p1) throw new Error('P1 is missing');
      p1.blocks = p1.blocks.filter((block) => block.id !== 'K2');
      await refused(storage, 'K2');
    });

    it('exports a board beside a topic.md it cannot read when no task names that topic', async () => {
      const { root, storage } = await board();
      await fill(storage);
      await writeFile(join(root, '.board/topics/P3/topic.md'), 'no frontmatter\n', 'utf8');
      const snapshot = await createSnapshot(storage, project);
      expect(snapshot.topics.map((topic) => topic.id)).toEqual(['P1', 'P2']);
      // The counters still say P3 was issued.
      expect(snapshot.sequence).toEqual({ topicSequence: 3, blockSequence: 3 });
    });

    it('the v4 schema itself refuses a dangling topic or block', async () => {
      const { storage } = await board();
      await fill(storage);
      const snapshot = (await exported(storage)) as {
        tasks: { topic?: string; block?: string }[];
        topics: { id: string; blocks: { id: string }[] }[];
      };
      expect(boardSnapshotSchema.safeParse(snapshot).success).toBe(true);

      const noTopic = structuredClone(snapshot);
      noTopic.topics = noTopic.topics.filter((topic) => topic.id !== 'P2');
      expect(boardSnapshotSchema.safeParse(noTopic).success).toBe(false);

      const noBlock = structuredClone(snapshot);
      noBlock.topics[0]!.blocks = noBlock.topics[0]!.blocks.filter((block) => block.id !== 'K2');
      expect(boardSnapshotSchema.safeParse(noBlock).success).toBe(false);

      const otherTopic = structuredClone(snapshot);
      otherTopic.tasks[0]!.block = 'K3';
      expect(boardSnapshotSchema.safeParse(otherTopic).success).toBe(false);
    });
  });
});

describe('export v4 keeps the unknown frontmatter fields of a topic (INVARIANT)', () => {
  /** A topic.md written by hand, with fields of the person's own of every YAML shape. */
  const handWritten = [
    '---',
    'id: P1',
    'title: M1 Core',
    'blocks:',
    '  - id: K1',
    '    title: Storage',
    'owner: toivo',
    'estimate: 3.5',
    'active: true',
    'reviewed: null',
    'due: "2026-12-01"',
    'tags: [m1, core]',
    'links:',
    '  - kind: adr',
    '    ref: ADR-0032',
    '    pinned: false',
    '  - kind: task',
    '    ref: T87',
    'meta:',
    '  phase:',
    '    name: Core',
    '    order: 2',
    '  notes: |',
    '    first line',
    '    second line',
    '---',
    '## Goal',
    '',
  ].join('\n');

  const extra = {
    owner: 'toivo',
    estimate: 3.5,
    active: true,
    reviewed: null,
    due: '2026-12-01',
    tags: ['m1', 'core'],
    links: [
      { kind: 'adr', ref: 'ADR-0032', pinned: false },
      { kind: 'task', ref: 'T87' },
    ],
    meta: { phase: { name: 'Core', order: 2 }, notes: 'first line\nsecond line\n' },
  };

  async function handWrittenBoard(): Promise<Storage> {
    const { root, storage } = await board();
    await mkdir(join(root, '.board/topics/P1'), { recursive: true });
    await writeFile(join(root, '.board/topics/P1/topic.md'), handWritten, 'utf8');
    await writeFile(
      join(root, '.board/topics/sequence.json'),
      JSON.stringify({ formatVersion: 1, topicSequence: 1, blockSequence: 1 }),
      'utf8',
    );
    return storage;
  }

  it('exports every unknown field with its value and structure, beside title and body', async () => {
    const snapshot = (await exported(await handWrittenBoard())) as {
      topics: Record<string, unknown>[];
    };
    expect(snapshot.topics).toEqual([
      {
        id: 'P1',
        title: 'M1 Core',
        body: '## Goal\n',
        blocks: [{ id: 'K1', title: 'Storage' }],
        extra,
      },
    ]);
  });

  it('keeps them through a restore of the export', async () => {
    const snapshot = await exported(await handWrittenBoard());
    const restored = await board();
    await restoreSnapshot(restored.root, snapshot);
    expect(await restored.storage.getTopic('P1')).toEqual({
      id: 'P1',
      title: 'M1 Core',
      body: '## Goal\n',
      blocks: [{ id: 'K1', title: 'Storage' }],
      extra,
    });
  });

  it('exports a topic without unknown fields without an extra', async () => {
    const { storage } = await board();
    await storage.createTopic({ title: 'Plain', body: '' });
    const snapshot = await createSnapshot(storage, project);
    expect(snapshot.topics[0]).not.toHaveProperty('extra');
  });
});

describe('export v4 keeps the counters of sequence.json (ADR-0020, INVARIANT)', () => {
  /** Restores the export into a new board and returns it opened. */
  async function restored(snapshot: unknown): Promise<Storage> {
    const target = await board();
    await restoreSnapshot(target.root, snapshot);
    return target.storage;
  }

  it('the highest topic deleted: a restored board does not issue its id again', async () => {
    const { storage } = await board();
    await fill(storage);
    const before = issued(await storage.listTopics());
    await storage.deleteTopic('P3');

    const snapshot = await exported(storage);
    expect(snapshot).toMatchObject({ sequence: { topicSequence: 3, blockSequence: 3 } });
    expect((snapshot as { topics: { id: string }[] }).topics.map((t) => t.id)).toEqual([
      'P1',
      'P2',
    ]);

    const target = await restored(snapshot);
    const topic = await target.createTopic({ title: 'New', body: '' });
    expect(topic.id).toBe('P4');
    expect(before).not.toContain(topic.id);
  });

  it('the highest block deleted: a restored board does not issue its id again', async () => {
    const { storage } = await board();
    await fill(storage);
    await storage.updateTask('T2', { topic: null, block: null });
    const before = issued(await storage.listTopics());
    await storage.deleteBlock('P2', 'K3');

    const snapshot = await exported(storage);
    expect(snapshot).toMatchObject({ sequence: { topicSequence: 3, blockSequence: 3 } });

    const target = await restored(snapshot);
    const block = await target.createBlock('P2', { title: 'New' });
    expect(block.id).toBe('K4');
    expect(before).not.toContain(block.id);
  });

  it('both deleted: the new topic and block repeat no id ever issued, the deleted included', async () => {
    const { storage } = await board();
    await fill(storage);
    await storage.updateTask('T2', { topic: null, block: null });
    const before = issued(await storage.listTopics());
    await storage.deleteBlock('P2', 'K3');
    await storage.deleteTopic('P2');
    await storage.deleteTopic('P3');
    // What is left would recover only P1 and K2.
    expect(issued(await storage.listTopics())).toEqual(['P1', 'K1', 'K2']);

    const snapshot = await exported(storage);
    const target = await restored(snapshot);
    expect(await target.listTasks()).toEqual((snapshot as { tasks: unknown[] }).tasks);
    expect(await target.listTopics()).toEqual((snapshot as { topics: unknown[] }).topics);

    const topic = await target.createTopic({ title: 'New', body: '' });
    const block = await target.createBlock(topic.id, { title: 'New' });
    expect([topic.id, block.id]).toEqual(['P4', 'K4']);
    expect(before).not.toContain(topic.id);
    expect(before).not.toContain(block.id);
  });

  it('exports counters ahead of every id as they are stored, not the highest id', async () => {
    const { root, storage } = await board();
    await fill(storage);
    await writeFile(
      join(root, '.board/topics/sequence.json'),
      JSON.stringify({ formatVersion: 1, topicSequence: 7, blockSequence: 11 }),
      'utf8',
    );
    const snapshot = await exported(storage);
    expect(snapshot).toMatchObject({ sequence: { topicSequence: 7, blockSequence: 11 } });
    const target = await restored(snapshot);
    expect((await target.createTopic({ title: 'New', body: '' })).id).toBe('P8');
    expect((await target.createBlock('P1', { title: 'New' })).id).toBe('K12');
  });

  it('exports lost counters as null and computes none', async () => {
    const { root, storage } = await board();
    await fill(storage);
    await writeFile(join(root, '.board/topics/sequence.json'), '{ "topicSequence": ', 'utf8');
    const snapshot = await exported(storage);
    expect(snapshot).toMatchObject({ sequence: null });
    // The restored board recovers from what exists, as the board it came from would (O-1).
    const target = await restored(snapshot);
    expect((await target.createTopic({ title: 'New', body: '' })).id).toBe('P4');
  });
});

describe('export v4 of a board whose sequence.json is corrupt JSON (ADR-0020, INVARIANT)', () => {
  it('succeeds, keeps every topic and block, and derives no counters from their ids', async () => {
    const { root, storage } = await board();
    await fill(storage);
    await writeFile(join(root, '.board/topics/sequence.json'), '{ not json at all', 'utf8');

    const snapshot = (await exported(storage)) as {
      sequence: unknown;
      topics: { id: string; blocks: { id: string }[] }[];
    };

    expect(snapshot.sequence).toBeNull();
    expect(snapshot.topics.map((topic) => topic.id)).toEqual(['P1', 'P2', 'P3']);
    expect(snapshot.topics.map((topic) => topic.blocks.map((block) => block.id))).toEqual([
      ['K1', 'K2'],
      ['K3'],
      [],
    ]);
    // Not { topicSequence: 3, blockSequence: 3 }, which the ids alone would give.
    expect(snapshot).not.toHaveProperty('sequence.topicSequence');
    expect(boardSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });
});

describe('the restore helper hides no format error', () => {
  it('refuses a v3 export: it holds no topics to restore', async () => {
    const target = await board();
    await expect(restoreSnapshot(target.root, await v3Fixture())).rejects.toThrow(
      'formatVersion 4',
    );
  });

  it('refuses an export with a dangling reference or a bad counter, and writes nothing', async () => {
    const { storage } = await board();
    await fill(storage);
    const snapshot = (await exported(storage)) as {
      topics: { id: string }[];
      sequence: { topicSequence: number };
    };

    const dangling = structuredClone(snapshot);
    dangling.topics = dangling.topics.filter((topic) => topic.id !== 'P1');
    const target = await board();
    await expect(restoreSnapshot(target.root, dangling)).rejects.toThrow();
    expect(await target.storage.listTasks()).toEqual([]);

    const negative = structuredClone(snapshot);
    negative.sequence.topicSequence = -1;
    await expect(restoreSnapshot(target.root, negative)).rejects.toThrow();
    expect(await target.storage.listTopics()).toEqual([]);
  });
});

describe('export v4 keeps the launch of a task as stored (ADR-0029 T94, K15, INVARIANT)', () => {
  const launch = {
    requestId: 'b7e1c0d2-3f4a-4b5c-9d6e-7f8091a2b3c4',
    requestedAt: '2026-11-06T09:00:00.000Z',
    afterRunId: 2,
    reports: true,
    failure: {
      kind: 'begin-refused' as const,
      message: 'Task "T1" is blocked.',
      at: '2026-11-06T09:00:01.000Z',
    },
  };

  it('holds the launch in tasks, unchanged, and stays formatVersion 4: the tasks as listTasks reads them', async () => {
    const { storage } = await board();
    await storage.createTask(newTask('Ship it'));
    await storage.createTask(newTask('Other'));
    await storage.updateTask('T1', { launch });

    const snapshot = boardSnapshotSchema.parse(await exported(storage));

    expect(snapshot.formatVersion).toBe(4);
    expect(snapshot.tasks.find((task) => task.id === 'T1')?.launch).toEqual(launch);
    expect(snapshot.tasks.find((task) => task.id === 'T2')).not.toHaveProperty('launch');
    expect(snapshot.tasks).toEqual(JSON.parse(JSON.stringify(await storage.listTasks())));
  });

  it('keeps it through a restore of the export, as a field of the task and not as an unknown one', async () => {
    const { storage } = await board();
    await storage.createTask(newTask('Ship it'));
    await storage.updateTask('T1', { launch });

    const target = await tmpDir();
    await restoreSnapshot(target, await exported(storage));
    const { storage: restored } = await board(target);

    const task = await restored.getTask('T1');
    expect(task?.launch).toEqual(launch);
    expect(task?.extra).toBeUndefined();
  });
});
