import { BoardError } from '../../src/core/errors.js';
import { taskSchema } from '../../src/core/model/index.js';
import type { NewTask, Storage } from '../../src/core/ports.js';

/** The counters of topics and blocks as a person could leave them, or a stored value. */
export type SequenceState =
  'missing' | 'invalid' | { topicSequence: number; blockSequence: number };

/**
 * One suite, every provider. It describes the behaviour of the Storage port and knows
 * nothing about files, YAML or memory. A new provider must pass it unchanged.
 */
export interface StorageHarness {
  name: string;
  /** A provider over a fresh, empty store. */
  create(options?: { idPrefix?: string }): Promise<Storage>;
  /** A new provider instance over the same store: the persistence check. */
  reopen(storage: Storage): Promise<Storage>;
  cleanup?(): Promise<void>;
  /**
   * Leaves a research with its `report.md` written and no record after it: the process ended
   * between the two writes (ADR-0030 R3). Only the provider knows what that looks like.
   */
  strandMarkdown(storage: Storage, taskId: string, number: number, markdown: string): Promise<void>;
  /**
   * What a person can do to topics by hand, and no method of the port does (ADR-0032 §2): delete
   * one, make one unreadable (and repair it again), and lose or rewind the counters.
   */
  removeTopic(storage: Storage, topicId: string): Promise<void>;
  breakTopic(storage: Storage, topicId: string): Promise<() => Promise<void>>;
  /** Adds a field of the person's own to a topic, as editing topic.md by hand would. */
  addTopicField(storage: Storage, topicId: string, key: string, value: unknown): Promise<void>;
  setSequence(storage: Storage, state: SequenceState): Promise<void>;
}

const newTask = (over: Partial<NewTask> = {}): NewTask => ({
  title: 'Write the conformance suite',
  status: 'todo',
  rank: 'a0',
  body: '## Context\n\nOne suite for every provider.\n',
  labels: ['storage'],
  ...over,
});

export function runStorageConformance(harness: StorageHarness): void {
  describe(`Storage conformance: ${harness.name}`, () => {
    let storage: Storage;
    const opened: Storage[] = [];

    async function open(options?: { idPrefix?: string }): Promise<Storage> {
      const provider = await harness.create(options);
      await provider.init();
      opened.push(provider);
      return provider;
    }

    async function reopen(provider: Storage): Promise<Storage> {
      await provider.close();
      const next = await harness.reopen(provider);
      await next.init();
      opened.push(next);
      return next;
    }

    async function expectCode(action: Promise<unknown>, code: string): Promise<void> {
      await expect(action).rejects.toThrow(BoardError);
      await action.catch((error: unknown) => {
        expect((error as BoardError).code).toBe(code);
      });
    }

    beforeEach(async () => {
      storage = await open();
    });

    afterEach(async () => {
      await Promise.all(opened.splice(0).map((provider) => provider.close()));
      await harness.cleanup?.();
    });

    describe('tasks', () => {
      it('create, get and list agree (INVARIANT 1)', async () => {
        const created = await storage.createTask(newTask());
        expect(taskSchema.parse(created)).toEqual(created);
        expect(await storage.getTask(created.id)).toEqual(created);
        expect(await storage.listTasks()).toEqual([created]);
      });

      it('keeps every field it was given', async () => {
        const created = await storage.createTask(
          newTask({ branch: 'feat/x', extra: { estimate: 3 } }),
        );
        expect(created).toMatchObject({
          title: 'Write the conformance suite',
          status: 'todo',
          rank: 'a0',
          body: '## Context\n\nOne suite for every provider.\n',
          labels: ['storage'],
          branch: 'feat/x',
          extra: { estimate: 3 },
        });
        expect(created.createdAt).toBe(created.updatedAt);
      });

      it('returns null for a task that does not exist', async () => {
        expect(await storage.getTask('T404')).toBeNull();
      });

      it('gives 20 concurrent creates 20 different ids (INVARIANT 2)', async () => {
        const created = await Promise.all(
          Array.from({ length: 20 }, (_, i) => storage.createTask(newTask({ title: `T${i}` }))),
        );
        const ids = created.map((task) => task.id);
        expect(new Set(ids).size).toBe(20);
        expect((await storage.listTasks()).length).toBe(20);
      });

      it('uses the configured id prefix', async () => {
        const provider = await open({ idPrefix: 'F' });
        expect((await provider.createTask(newTask())).id).toBe('F1');
      });

      it('never reuses the id of a deleted task (INVARIANT 10)', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) ids.push((await storage.createTask(newTask())).id);
        await storage.deleteTask(ids[2] as string);
        const next = await storage.createTask(newTask());
        expect(ids).not.toContain(next.id);
      });

      it('keeps the id sequence across a reopen (INVARIANT 10)', async () => {
        const first = await storage.createTask(newTask());
        await storage.deleteTask(first.id);
        const reopened = await reopen(storage);
        const next = await reopened.createTask(newTask());
        expect(next.id).not.toBe(first.id);
      });

      it('keeps the tasks themselves across a reopen', async () => {
        const created = await storage.createTask(newTask({ extra: { estimate: 3 } }));
        const reopened = await reopen(storage);
        expect(await reopened.getTask(created.id)).toEqual(created);
      });

      it('updates only the given fields and moves updatedAt (INVARIANT 3)', async () => {
        const created = await storage.createTask(newTask({ branch: 'feat/x' }));
        await new Promise((resolve) => setTimeout(resolve, 2));
        const updated = await storage.updateTask(created.id, { status: 'done' });
        expect(updated).toEqual({ ...created, status: 'done', updatedAt: updated.updatedAt });
        expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
        expect(updated.createdAt).toBe(created.createdAt);
      });

      it('clears the branch when the patch says null', async () => {
        const created = await storage.createTask(newTask({ branch: 'feat/x' }));
        const updated = await storage.updateTask(created.id, { branch: null });
        expect(updated.branch).toBeUndefined();
      });

      it('keeps unknown frontmatter fields across an update (INVARIANT 8)', async () => {
        const created = await storage.createTask(newTask({ extra: { estimate: 3, owner: 'me' } }));
        const updated = await storage.updateTask(created.id, { title: 'Renamed' });
        expect(updated.extra).toEqual({ estimate: 3, owner: 'me' });
        expect((await storage.getTask(created.id))?.extra).toEqual({ estimate: 3, owner: 'me' });
      });

      it('round-trips content that could break a file format (INVARIANT 9)', async () => {
        const body = '---\nnot: frontmatter\n---\n\n# Заголовок 🎯\n\n\ttabs   and  spaces\n';
        const created = await storage.createTask(
          newTask({ title: 'Title: with "quotes" — and a dash', body, labels: ['a b', 'ü'] }),
        );
        const read = await storage.getTask(created.id);
        expect(read?.body).toBe(body);
        expect(read?.title).toBe('Title: with "quotes" — and a dash');
        expect(read?.labels).toEqual(['a b', 'ü']);
      });

      it('round-trips an empty body', async () => {
        const created = await storage.createTask(newTask({ body: '' }));
        expect((await storage.getTask(created.id))?.body).toBe('');
      });

      it('refuses to update or delete a task that does not exist', async () => {
        await expectCode(storage.updateTask('T404', { title: 'x' }), 'TASK_NOT_FOUND');
        await expectCode(storage.deleteTask('T404'), 'TASK_NOT_FOUND');
      });

      it('lists tasks in allocation order, the same order for every provider', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) ids.push((await storage.createTask(newTask())).id);
        expect((await storage.listTasks()).map((task) => task.id)).toEqual(ids);
      });

      it('reports no read problems for a board it wrote itself', async () => {
        await storage.createTask(newTask());
        expect(await storage.readIssues()).toEqual([]);
      });

      it('is idempotent on a second init (INVARIANT 7)', async () => {
        const created = await storage.createTask(newTask());
        await storage.init();
        expect(await storage.listTasks()).toEqual([created]);
      });
    });

    describe('topic, block and dependsOn of a task (ADR-0032 §3, T82)', () => {
      /** P1 with K1 and P2 with K2, so a block of the other topic can be named. */
      async function topics(provider: Storage = storage): Promise<void> {
        const first = await provider.createTopic({ title: 'first', body: '' });
        await provider.createBlock(first.id, { title: 'one' });
        const second = await provider.createTopic({ title: 'second', body: '' });
        await provider.createBlock(second.id, { title: 'two' });
      }

      it('has none of them for a task created without (INVARIANT)', async () => {
        const created = await storage.createTask(newTask());
        for (const key of ['topic', 'block', 'dependsOn']) {
          expect(created).not.toHaveProperty(key);
          expect(await storage.getTask(created.id)).not.toHaveProperty(key);
        }
      });

      it('keeps them across a read and a reopen, and out of extra (INVARIANT)', async () => {
        await topics();
        const placed = { topic: 'P1', block: 'K1', dependsOn: ['T7', 'T9'] };
        const created = await storage.createTask(newTask({ ...placed, extra: { estimate: 3 } }));
        expect(created).toMatchObject(placed);
        const reopened = await reopen(storage);
        const read = await reopened.getTask(created.id);
        expect(read).toMatchObject(placed);
        expect(read?.extra).toEqual({ estimate: 3 });
        expect(taskSchema.safeParse(read).success).toBe(true);
      });

      it('sets them on update, and clears them with null', async () => {
        await topics();
        const created = await storage.createTask(newTask());
        const placed = await storage.updateTask(created.id, {
          topic: 'P1',
          block: 'K1',
          dependsOn: ['T2'],
        });
        expect(placed).toMatchObject({ topic: 'P1', block: 'K1', dependsOn: ['T2'] });
        const cleared = await storage.updateTask(created.id, {
          topic: null,
          block: null,
          dependsOn: null,
        });
        for (const key of ['topic', 'block', 'dependsOn']) expect(cleared).not.toHaveProperty(key);
        expect(await storage.getTask(created.id)).toEqual(cleared);
      });

      it('leaves them alone when the patch does not mention them', async () => {
        await topics();
        const created = await storage.createTask(
          newTask({ topic: 'P1', block: 'K1', dependsOn: ['T2'] }),
        );
        const updated = await storage.updateTask(created.id, { title: 'Renamed' });
        expect(updated).toMatchObject({ topic: 'P1', block: 'K1', dependsOn: ['T2'] });
      });

      it('takes a topic without a block, and moves a task to another topic and block', async () => {
        await topics();
        const created = await storage.createTask(newTask({ topic: 'P1' }));
        expect(created).not.toHaveProperty('block');
        const moved = await storage.updateTask(created.id, { topic: 'P2', block: 'K2' });
        expect(moved).toMatchObject({ topic: 'P2', block: 'K2' });
      });

      describe('a block belongs to the topic it is named with (INVARIANT)', () => {
        it('refuses a block without a topic, and writes nothing', async () => {
          await topics();
          await expectCode(storage.createTask(newTask({ block: 'K1' })), 'INVALID_REQUEST');
          expect(await storage.listTasks()).toEqual([]);
          const created = await storage.createTask(newTask());
          await expectCode(storage.updateTask(created.id, { block: 'K1' }), 'INVALID_REQUEST');
          expect(await storage.getTask(created.id)).toEqual(created);
        });

        it('refuses a block of another topic, on create and on update', async () => {
          await topics();
          await expectCode(
            storage.createTask(newTask({ topic: 'P1', block: 'K2' })),
            'INVALID_REQUEST',
          );
          expect(await storage.listTasks()).toEqual([]);
          const created = await storage.createTask(newTask({ topic: 'P1', block: 'K1' }));
          await expectCode(storage.updateTask(created.id, { block: 'K2' }), 'INVALID_REQUEST');
          expect(await storage.getTask(created.id)).toEqual(created);
        });

        it('refuses a block of a topic that does not exist, or a block that does not exist', async () => {
          await topics();
          await expectCode(
            storage.createTask(newTask({ topic: 'P9', block: 'K1' })),
            'INVALID_REQUEST',
          );
          await expectCode(
            storage.createTask(newTask({ topic: 'P1', block: 'K9' })),
            'INVALID_REQUEST',
          );
          expect(await storage.listTasks()).toEqual([]);
        });

        it('refuses a new topic that leaves the old block behind, and a topic cleared under a block', async () => {
          await topics();
          const created = await storage.createTask(newTask({ topic: 'P1', block: 'K1' }));
          await expectCode(storage.updateTask(created.id, { topic: 'P2' }), 'INVALID_REQUEST');
          await expectCode(storage.updateTask(created.id, { topic: null }), 'INVALID_REQUEST');
          expect(await storage.getTask(created.id)).toEqual(created);
        });
      });

      describe('dependsOn names tasks in the form of the configured prefix (INVARIANT)', () => {
        it('takes ids of the configured prefix, a task that does not exist included', async () => {
          const provider = await open({ idPrefix: 'F' });
          const created = await provider.createTask(newTask({ dependsOn: ['F3', 'F40'] }));
          expect(created.dependsOn).toEqual(['F3', 'F40']);
        });

        it.each([
          ['an id of another prefix', ['T3']],
          ['a topic id', ['P1']],
          ['a block id', ['K1']],
          ['text that is not an id', ['F3x']],
          ['an id with a leading zero', ['F03']],
        ])('refuses %s, on create and on update, and writes nothing', async (_name, ids) => {
          const provider = await open({ idPrefix: 'F' });
          await expectCode(provider.createTask(newTask({ dependsOn: ids })), 'INVALID_REQUEST');
          expect(await provider.listTasks()).toEqual([]);
          const created = await provider.createTask(newTask());
          await expectCode(provider.updateTask(created.id, { dependsOn: ids }), 'INVALID_REQUEST');
          expect(await provider.getTask(created.id)).toEqual(created);
        });
      });
    });

    describe('topic and block ids (ADR-0032 §2)', () => {
      const topic = (title = 'M1 Core'): { title: string; body: string } => ({ title, body: '' });

      /** P1 with K1, K2 and P2 with K3: the highest topic and the highest block are in P2. */
      async function twoTopics(provider: Storage = storage): Promise<void> {
        const first = await provider.createTopic(topic('first'));
        await provider.createBlock(first.id, { title: 'one' });
        await provider.createBlock(first.id, { title: 'two' });
        const second = await provider.createTopic(topic('second'));
        await provider.createBlock(second.id, { title: 'three' });
      }

      it('numbers topics P1, P2 and blocks K1, K2, globally and each on its own', async () => {
        const first = await storage.createTopic(topic());
        const k1 = await storage.createBlock(first.id, { title: 'A' });
        const k2 = await storage.createBlock(first.id, { title: 'B' });
        const second = await storage.createTopic(topic('Revalidation'));
        const k3 = await storage.createBlock(second.id, { title: 'C' });
        expect([first.id, second.id]).toEqual(['P1', 'P2']);
        expect([k1.id, k2.id, k3.id]).toEqual(['K1', 'K2', 'K3']);
        expect(first).toEqual({ id: 'P1', title: 'M1 Core', body: '', blocks: [] });
        expect(k1).toEqual({ id: 'K1', title: 'A' });
      });

      it('does not use the task id prefix or the task sequence', async () => {
        const provider = await open({ idPrefix: 'F' });
        await provider.createTask(newTask());
        await provider.createTask(newTask());
        expect((await provider.createTopic(topic())).id).toBe('P1');
        expect((await provider.createTask(newTask())).id).toBe('F3');
      });

      it('never reuses the id of the highest topic and block once deleted (INVARIANT)', async () => {
        await twoTopics();
        await harness.removeTopic(storage, 'P2');
        const next = await storage.createTopic(topic());
        expect(next.id).toBe('P3');
        expect((await storage.createBlock('P1', { title: 'four' })).id).toBe('K4');
      });

      it('keeps the counters across a reopen (INVARIANT)', async () => {
        await twoTopics();
        await harness.removeTopic(storage, 'P2');
        const reopened = await reopen(storage);
        expect((await reopened.createTopic(topic())).id).toBe('P3');
        expect((await reopened.createBlock('P1', { title: 'four' })).id).toBe('K4');
      });

      it.each(['missing', 'invalid'] as const)(
        'recovers %s counters from the topics and blocks that exist',
        async (state) => {
          await twoTopics();
          await harness.setSequence(storage, state);
          const reopened = await reopen(storage);
          expect((await reopened.createBlock('P1', { title: 'four' })).id).toBe('K4');
          expect((await reopened.createTopic(topic())).id).toBe('P3');
        },
      );

      it('goes on from the highest existing id when the counters are behind it', async () => {
        await twoTopics();
        await harness.setSequence(storage, { topicSequence: 1, blockSequence: 0 });
        expect((await storage.createTopic(topic())).id).toBe('P3');
        expect((await storage.createBlock('P1', { title: 'four' })).id).toBe('K4');
      });

      it('writes the counters back after recovering them: a later delete reuses nothing', async () => {
        await twoTopics();
        await harness.setSequence(storage, 'missing');
        expect((await storage.createTopic(topic())).id).toBe('P3');
        await harness.removeTopic(storage, 'P3');
        await harness.removeTopic(storage, 'P2');
        expect((await storage.createTopic(topic())).id).toBe('P4');
        expect((await storage.createBlock('P1', { title: 'four' })).id).toBe('K4');
      });

      it('gives concurrent creates different ids and loses no block (INVARIANT)', async () => {
        const topics = await Promise.all(
          Array.from({ length: 10 }, (_, i) => storage.createTopic(topic(`T${i}`))),
        );
        expect(new Set(topics.map((t) => t.id)).size).toBe(10);

        const blocks = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            storage.createBlock(i % 2 === 0 ? 'P1' : 'P2', { title: `B${i}` }),
          ),
        );
        const ids = blocks.map((block) => block.id);
        expect(new Set(ids).size).toBe(20);
        // Every block was appended to its topic: none was written over by another.
        const held = [
          ...((await storage.getTopic('P1'))?.blocks ?? []),
          ...((await storage.getTopic('P2'))?.blocks ?? []),
        ];
        expect(held.map((block) => block.id).sort()).toEqual([...ids].sort());
        expect((await storage.createBlock('P1', { title: 'last' })).id).toBe('K21');
      });

      it('appends a block to the end of its topic, in order', async () => {
        const created = await storage.createTopic(topic());
        await storage.createBlock(created.id, { title: 'first' });
        await storage.createBlock(created.id, { title: 'second' });
        const other = await storage.createTopic(topic('other'));
        expect(await storage.createBlock(other.id, { title: 'x' })).toEqual({
          id: 'K3',
          title: 'x',
        });
        expect(await storage.getTopic(created.id)).toEqual({
          id: 'P1',
          title: 'M1 Core',
          body: '',
          blocks: [
            { id: 'K1', title: 'first' },
            { id: 'K2', title: 'second' },
          ],
        });
        expect((await storage.getTopic(other.id))?.blocks).toEqual([{ id: 'K3', title: 'x' }]);
      });

      it('keeps a topic and its blocks across a reopen', async () => {
        const created = await storage.createTopic({ title: 'M1', body: '## Goal\n\nShip it.\n' });
        await storage.createBlock(created.id, { title: 'A' });
        const reopened = await reopen(storage);
        expect(await reopened.getTopic(created.id)).toEqual({
          id: 'P1',
          title: 'M1',
          body: '## Goal\n\nShip it.\n',
          blocks: [{ id: 'K1', title: 'A' }],
        });
      });

      it('returns null for a topic that does not exist or is not a topic id', async () => {
        expect(await storage.getTopic('P1')).toBeNull();
        expect(await storage.getTopic('T1')).toBeNull();
        expect(await storage.getTopic('../P1')).toBeNull();
      });

      it('refuses a block for a topic that does not exist, and allocates nothing', async () => {
        await expectCode(storage.createBlock('P9', { title: 'x' }), 'TOPIC_NOT_FOUND');
        await expectCode(storage.createBlock('T1', { title: 'x' }), 'TOPIC_NOT_FOUND');
        await expectCode(storage.createBlock('../P1', { title: 'x' }), 'TOPIC_NOT_FOUND');
        const created = await storage.createTopic(topic());
        expect((await storage.createBlock(created.id, { title: 'x' })).id).toBe('K1');
      });

      describe('reading a topic back (T81)', () => {
        it('keeps a field of its own that the board does not know, whole (INVARIANT)', async () => {
          const created = await storage.createTopic(topic());
          const value = { team: ['a', 'b'], n: 3 };
          await harness.addTopicField(storage, created.id, 'owner', value);
          expect((await storage.getTopic(created.id))?.extra).toEqual({ owner: value });
        });

        it('does not drop an unknown field when a block is added (INVARIANT)', async () => {
          const created = await storage.createTopic(topic());
          await harness.addTopicField(storage, created.id, 'owner', 'me');
          await storage.createBlock(created.id, { title: 'A' });
          const reopened = await reopen(storage);
          const read = await reopened.getTopic(created.id);
          expect(read?.extra).toEqual({ owner: 'me' });
          expect(read?.blocks).toEqual([{ id: 'K1', title: 'A' }]);
          expect(read?.title).toBe('M1 Core');
        });

        it('has no extra for a topic without unknown fields', async () => {
          const created = await storage.createTopic(topic());
          expect(created).not.toHaveProperty('extra');
          expect(await storage.getTopic(created.id)).not.toHaveProperty('extra');
        });

        it('gives every block of every topic an id of its own (INVARIANT)', async () => {
          await twoTopics();
          const third = await storage.createTopic(topic('third'));
          await storage.createBlock(third.id, { title: 'x' });
          const blocks = await Promise.all(
            ['P1', 'P2', 'P3'].map(async (id) => (await storage.getTopic(id))?.blocks ?? []),
          );
          const all = blocks.flat().map((block) => block.id);
          expect(all).toEqual(['K1', 'K2', 'K3', 'K4']);
          expect(new Set(all).size).toBe(all.length);
        });

        it('reports a topic it cannot read in readIssues, and stops when it is repaired', async () => {
          await twoTopics();
          expect(await storage.readIssues()).toEqual([]);
          const repair = await harness.breakTopic(storage, 'P2');
          const issues = await storage.readIssues();
          expect(issues.map((issue) => issue.file)).toEqual(['topics/P2/topic.md']);
          expect(issues[0]?.message).not.toBe('');
          await repair();
          expect(await storage.readIssues()).toEqual([]);
        });

        it('leaves the other topics readable beside one it cannot read', async () => {
          await twoTopics();
          await harness.breakTopic(storage, 'P2');
          expect((await storage.getTopic('P1'))?.blocks.map((b) => b.id)).toEqual(['K1', 'K2']);
          expect(await storage.getTopic('P2')).toBeNull();
        });
      });

      describe('fail-closed when the counters are lost (O-1, INVARIANT)', () => {
        beforeEach(async () => {
          await twoTopics();
          await storage.createTask(newTask());
        });

        it.each(['missing', 'invalid'] as const)(
          'refuses to create a topic or a block when the counters are %s and a topic cannot be read',
          async (state) => {
            await harness.breakTopic(storage, 'P2');
            await harness.setSequence(storage, state);
            await expectCode(storage.createTopic(topic()), 'ID_SEQUENCE_UNRECOVERABLE');
            await expectCode(
              storage.createBlock('P1', { title: 'four' }),
              'ID_SEQUENCE_UNRECOVERABLE',
            );
          },
        );

        it('says which file is the reason', async () => {
          await harness.breakTopic(storage, 'P2');
          await harness.setSequence(storage, 'missing');
          const error = await storage.createTopic(topic()).catch((e: unknown) => e);
          expect(error).toBeInstanceOf(BoardError);
          expect((error as BoardError).details).toMatchObject({
            files: [expect.stringContaining('P2')],
          });
        });

        it('keeps the rest of the board working', async () => {
          await harness.breakTopic(storage, 'P2');
          await harness.setSequence(storage, 'missing');
          await expectCode(storage.createTopic(topic()), 'ID_SEQUENCE_UNRECOVERABLE');
          expect((await storage.getTopic('P1'))?.blocks.map((b) => b.id)).toEqual(['K1', 'K2']);
          expect(await storage.getTopic('P2')).toBeNull();
          expect((await storage.listTasks()).map((t) => t.id)).toEqual(['T1']);
          expect(await storage.getTask('T1')).not.toBeNull();
          await expect(storage.readIssues()).resolves.toBeInstanceOf(Array);
          const task = await storage.createTask(newTask());
          expect(task.id).toBe('T2');
          await storage.updateTask(task.id, { status: 'done' });
          await storage.writeDocument(task.id, 'plan.md', '# Plan\n');
          expect(await storage.readDocument(task.id, 'plan.md')).toBe('# Plan\n');
        });

        it('creates again once the topic can be read, and reuses no id', async () => {
          const repair = await harness.breakTopic(storage, 'P2');
          await harness.setSequence(storage, 'missing');
          await expectCode(storage.createTopic(topic()), 'ID_SEQUENCE_UNRECOVERABLE');
          await repair();
          expect((await storage.createTopic(topic())).id).toBe('P3');
          expect((await storage.createBlock('P1', { title: 'four' })).id).toBe('K4');
        });

        it('does not stop creation when the counters are valid', async () => {
          await harness.breakTopic(storage, 'P2');
          expect((await storage.createTopic(topic())).id).toBe('P3');
          expect((await storage.createBlock('P1', { title: 'four' })).id).toBe('K4');
        });

        it('does not stop creation when the counters are lost but every topic can be read', async () => {
          await harness.setSequence(storage, 'missing');
          expect((await storage.createTopic(topic())).id).toBe('P3');
        });

        it('does not write a block into a topic it cannot read', async () => {
          const repair = await harness.breakTopic(storage, 'P2');
          await expectCode(storage.createBlock('P2', { title: 'x' }), 'TOPIC_NOT_FOUND');
          await repair();
          expect((await storage.getTopic('P2'))?.blocks.map((b) => b.id)).toEqual(['K3']);
        });

        it('writes nothing when it refuses', async () => {
          await harness.breakTopic(storage, 'P2');
          await harness.setSequence(storage, 'missing');
          await expectCode(storage.createBlock('P1', { title: 'x' }), 'ID_SEQUENCE_UNRECOVERABLE');
          await expectCode(storage.createTopic(topic()), 'ID_SEQUENCE_UNRECOVERABLE');
          expect((await storage.getTopic('P1'))?.blocks.map((b) => b.id)).toEqual(['K1', 'K2']);
          expect(await storage.getTopic('P3')).toBeNull();
        });
      });
    });

    describe('topic and block writes (ADR-0032 §4, T84)', () => {
      const topic = (title = 'M1 Core'): { title: string; body: string } => ({ title, body: '' });
      const ids = (blocks: readonly { id: string }[] | undefined): string[] =>
        (blocks ?? []).map((block) => block.id);

      /** P1 with K1, K2, K3 and P2 with K4, all empty; no tasks. */
      async function twoTopics(provider: Storage = storage): Promise<void> {
        const first = await provider.createTopic(topic('first'));
        for (const title of ['one', 'two', 'three']) {
          await provider.createBlock(first.id, { title });
        }
        const second = await provider.createTopic(topic('second'));
        await provider.createBlock(second.id, { title: 'four' });
      }

      /** Everything a refused write must leave as it was, read through the port. */
      async function boardState(provider: Storage = storage): Promise<unknown> {
        const topics = await Promise.all(
          Array.from({ length: 6 }, (_, i) => provider.getTopic(`P${i + 1}`)),
        );
        return {
          topics,
          tasks: await provider.listTasks(),
          issues: await provider.readIssues(),
        };
      }

      /** A refused write: the code, and the board exactly as it was (INVARIANT). */
      async function expectRefused(action: Promise<unknown>, code: string): Promise<void> {
        const before = await boardState();
        await expectCode(action, code);
        expect(await boardState()).toEqual(before);
      }

      describe('updateTopic', () => {
        it('changes the title and the body, and nothing else', async () => {
          await twoTopics();
          const updated = await storage.updateTopic('P1', { title: 'Renamed', body: '## New\n' });
          expect(updated).toEqual({
            id: 'P1',
            title: 'Renamed',
            body: '## New\n',
            blocks: [
              { id: 'K1', title: 'one' },
              { id: 'K2', title: 'two' },
              { id: 'K3', title: 'three' },
            ],
          });
          expect(await storage.getTopic('P1')).toEqual(updated);
          expect((await storage.getTopic('P2'))?.title).toBe('second');
        });

        it('changes only the fields it is given', async () => {
          const created = await storage.createTopic({ title: 'Keep', body: 'Body\n' });
          expect(await storage.updateTopic(created.id, { title: 'New' })).toMatchObject({
            title: 'New',
            body: 'Body\n',
          });
          expect(await storage.updateTopic(created.id, { body: 'Other\n' })).toMatchObject({
            title: 'New',
            body: 'Other\n',
          });
        });

        it('keeps a field of its own that the board does not know (INVARIANT)', async () => {
          const created = await storage.createTopic(topic());
          await harness.addTopicField(storage, created.id, 'owner', { team: ['a'] });
          await storage.updateTopic(created.id, { title: 'Renamed' });
          const reopened = await reopen(storage);
          expect((await reopened.getTopic(created.id))?.extra).toEqual({ owner: { team: ['a'] } });
        });

        it('keeps the change across a reopen', async () => {
          await twoTopics();
          await storage.updateTopic('P2', { title: 'Renamed' });
          const reopened = await reopen(storage);
          expect((await reopened.getTopic('P2'))?.title).toBe('Renamed');
        });

        it('refuses a topic that does not exist or cannot be read, and writes nothing', async () => {
          await twoTopics();
          await expectRefused(storage.updateTopic('P9', { title: 'x' }), 'TOPIC_NOT_FOUND');
          await expectRefused(storage.updateTopic('T1', { title: 'x' }), 'TOPIC_NOT_FOUND');
          await harness.breakTopic(storage, 'P2');
          await expectRefused(storage.updateTopic('P2', { title: 'x' }), 'TOPIC_NOT_FOUND');
        });
      });

      describe('deleteTopic', () => {
        it('deletes a topic that has no blocks and no tasks', async () => {
          await twoTopics();
          const empty = await storage.createTopic(topic('empty'));
          await storage.deleteTopic(empty.id);
          expect(await storage.getTopic(empty.id)).toBeNull();
          expect(ids((await storage.getTopic('P1'))?.blocks)).toEqual(['K1', 'K2', 'K3']);
          const reopened = await reopen(storage);
          expect(await reopened.getTopic(empty.id)).toBeNull();
        });

        it('refuses a topic that does not exist, and writes nothing', async () => {
          await twoTopics();
          await expectRefused(storage.deleteTopic('P9'), 'TOPIC_NOT_FOUND');
          await expectRefused(storage.deleteTopic('../P1'), 'TOPIC_NOT_FOUND');
        });

        it('refuses a topic that has tasks (INVARIANT)', async () => {
          const created = await storage.createTopic(topic());
          await storage.createTask(newTask({ topic: created.id }));
          await expectRefused(storage.deleteTopic(created.id), 'TOPIC_NOT_EMPTY');
        });

        it('refuses a topic that has only an empty block: an empty block makes it non-empty (INVARIANT)', async () => {
          const created = await storage.createTopic(topic());
          await storage.createBlock(created.id, { title: 'empty' });
          await expectRefused(storage.deleteTopic(created.id), 'TOPIC_NOT_EMPTY');
        });

        it('refuses a topic that has a block with tasks (INVARIANT)', async () => {
          const created = await storage.createTopic(topic());
          const block = await storage.createBlock(created.id, { title: 'busy' });
          await storage.createTask(newTask({ topic: created.id, block: block.id }));
          await expectRefused(storage.deleteTopic(created.id), 'TOPIC_NOT_EMPTY');
        });

        it('names the reason in the error', async () => {
          const created = await storage.createTopic(topic());
          await storage.createBlock(created.id, { title: 'empty' });
          await storage.createTask(newTask({ topic: created.id }));
          const error = await storage.deleteTopic(created.id).catch((e: unknown) => e);
          expect((error as BoardError).details).toMatchObject({
            id: created.id,
            blocks: ['K1'],
            tasks: ['T1'],
          });
        });

        it('deletes it once its tasks and blocks are gone', async () => {
          const created = await storage.createTopic(topic());
          const block = await storage.createBlock(created.id, { title: 'b' });
          const placed = await storage.createTask(newTask({ topic: created.id, block: block.id }));
          await expectCode(storage.deleteTopic(created.id), 'TOPIC_NOT_EMPTY');
          await storage.deleteTask(placed.id);
          await expectCode(storage.deleteTopic(created.id), 'TOPIC_NOT_EMPTY');
          await storage.deleteBlock(created.id, block.id);
          await storage.deleteTopic(created.id);
          expect(await storage.getTopic(created.id)).toBeNull();
        });

        it('does not look at the tasks of other topics', async () => {
          await twoTopics();
          const empty = await storage.createTopic(topic('empty'));
          await storage.createTask(newTask({ topic: 'P1', block: 'K1' }));
          await storage.deleteTopic(empty.id);
          expect(await storage.getTopic(empty.id)).toBeNull();
          expect(await storage.listTasks()).toHaveLength(1);
        });

        it('never reuses its id, or the ids of its blocks, once deleted (INVARIANT)', async () => {
          await twoTopics();
          await storage.deleteBlock('P2', 'K4');
          await storage.deleteTopic('P2');
          expect((await storage.createTopic(topic())).id).toBe('P3');
          expect((await storage.createBlock('P3', { title: 'x' })).id).toBe('K5');
        });

        it.each(['missing', 'invalid'] as const)(
          'never reuses an id when the counters are %s at the time of the delete (INVARIANT)',
          async (state) => {
            await twoTopics();
            await harness.setSequence(storage, state);
            await storage.deleteBlock('P2', 'K4');
            await storage.deleteTopic('P2');
            const reopened = await reopen(storage);
            expect((await reopened.createTopic(topic())).id).toBe('P3');
            expect((await reopened.createBlock('P3', { title: 'x' })).id).toBe('K5');
          },
        );
      });

      describe('createBlock, updateBlock', () => {
        it('renames a block in place: its id and its place stay', async () => {
          await twoTopics();
          const renamed = await storage.updateBlock('P1', 'K2', { title: 'Renamed' });
          expect(renamed).toEqual({ id: 'K2', title: 'Renamed' });
          expect((await storage.getTopic('P1'))?.blocks).toEqual([
            { id: 'K1', title: 'one' },
            { id: 'K2', title: 'Renamed' },
            { id: 'K3', title: 'three' },
          ]);
          const reopened = await reopen(storage);
          expect((await reopened.getTopic('P1'))?.blocks[1]).toEqual({
            id: 'K2',
            title: 'Renamed',
          });
        });

        it('keeps the tasks of a renamed block where they are', async () => {
          await twoTopics();
          await storage.createTask(newTask({ topic: 'P1', block: 'K2' }));
          await storage.updateBlock('P1', 'K2', { title: 'Renamed' });
          expect(await storage.getTask('T1')).toMatchObject({ topic: 'P1', block: 'K2' });
        });

        it('refuses a topic or a block that does not exist, and writes nothing', async () => {
          await twoTopics();
          await expectRefused(storage.updateBlock('P9', 'K1', { title: 'x' }), 'TOPIC_NOT_FOUND');
          await expectRefused(storage.updateBlock('P1', 'K9', { title: 'x' }), 'BLOCK_NOT_FOUND');
          await expectRefused(storage.updateBlock('P1', 'T1', { title: 'x' }), 'BLOCK_NOT_FOUND');
        });

        it('refuses a block of another topic: there is no move between topics', async () => {
          await twoTopics();
          await expectRefused(storage.updateBlock('P1', 'K4', { title: 'x' }), 'BLOCK_NOT_FOUND');
          await expectRefused(storage.updateBlock('P2', 'K1', { title: 'x' }), 'BLOCK_NOT_FOUND');
        });

        it('gives a block the next global id whichever topic it is in (INVARIANT)', async () => {
          await twoTopics();
          const a = await storage.createBlock('P2', { title: 'five' });
          const b = await storage.createBlock('P1', { title: 'six' });
          expect([a.id, b.id]).toEqual(['K5', 'K6']);
          const all = [
            ...ids((await storage.getTopic('P1'))?.blocks),
            ...ids((await storage.getTopic('P2'))?.blocks),
          ];
          expect(new Set(all).size).toBe(all.length);
        });
      });

      describe('reorderBlocks', () => {
        it('puts the blocks in the order given, and returns the topic', async () => {
          await twoTopics();
          const reordered = await storage.reorderBlocks('P1', ['K3', 'K1', 'K2']);
          expect(ids(reordered.blocks)).toEqual(['K3', 'K1', 'K2']);
          expect(reordered.blocks[0]).toEqual({ id: 'K3', title: 'three' });
          expect(ids((await storage.getTopic('P1'))?.blocks)).toEqual(['K3', 'K1', 'K2']);
        });

        it('keeps the order after a reopen, and a block added later goes last (INVARIANT)', async () => {
          await twoTopics();
          await storage.reorderBlocks('P1', ['K2', 'K3', 'K1']);
          const reopened = await reopen(storage);
          expect(ids((await reopened.getTopic('P1'))?.blocks)).toEqual(['K2', 'K3', 'K1']);
          await reopened.createBlock('P1', { title: 'five' });
          expect(ids((await reopened.getTopic('P1'))?.blocks)).toEqual(['K2', 'K3', 'K1', 'K5']);
        });

        it('leaves the other topics, the title and the body alone', async () => {
          await twoTopics();
          await storage.updateTopic('P1', { title: 'T', body: 'B\n' });
          const other = await storage.getTopic('P2');
          await storage.reorderBlocks('P1', ['K3', 'K2', 'K1']);
          expect(await storage.getTopic('P2')).toEqual(other);
          expect(await storage.getTopic('P1')).toMatchObject({ title: 'T', body: 'B\n' });
        });

        it('accepts the order it already has', async () => {
          await twoTopics();
          const same = await storage.reorderBlocks('P1', ['K1', 'K2', 'K3']);
          expect(ids(same.blocks)).toEqual(['K1', 'K2', 'K3']);
        });

        it.each([
          ['a block left out', ['K1', 'K2']],
          ['a block twice', ['K1', 'K2', 'K2']],
          ['a block of another topic', ['K1', 'K2', 'K4']],
          ['a block that does not exist', ['K1', 'K2', 'K9']],
          ['one block too many', ['K1', 'K2', 'K3', 'K4']],
          ['no blocks', []],
        ])('refuses an order with %s, and writes nothing', async (_name, order) => {
          await twoTopics();
          await expectRefused(storage.reorderBlocks('P1', order), 'INVALID_REQUEST');
        });

        it('refuses a topic that does not exist, and writes nothing', async () => {
          await twoTopics();
          await expectRefused(storage.reorderBlocks('P9', ['K1']), 'TOPIC_NOT_FOUND');
        });

        it('does not change the place of any task', async () => {
          await twoTopics();
          await storage.createTask(newTask({ topic: 'P1', block: 'K2' }));
          await storage.reorderBlocks('P1', ['K3', 'K2', 'K1']);
          expect(await storage.getTask('T1')).toMatchObject({ topic: 'P1', block: 'K2' });
        });
      });

      describe('deleteBlock', () => {
        it('deletes a block that has no tasks, and keeps the order of the others', async () => {
          await twoTopics();
          await storage.deleteBlock('P1', 'K2');
          expect((await storage.getTopic('P1'))?.blocks).toEqual([
            { id: 'K1', title: 'one' },
            { id: 'K3', title: 'three' },
          ]);
          const reopened = await reopen(storage);
          expect(ids((await reopened.getTopic('P1'))?.blocks)).toEqual(['K1', 'K3']);
          expect(ids((await reopened.getTopic('P2'))?.blocks)).toEqual(['K4']);
        });

        it('refuses a block that has tasks (INVARIANT)', async () => {
          await twoTopics();
          await storage.createTask(newTask({ topic: 'P1', block: 'K2' }));
          await expectRefused(storage.deleteBlock('P1', 'K2'), 'BLOCK_NOT_EMPTY');
        });

        it('names the tasks in the error', async () => {
          await twoTopics();
          await storage.createTask(newTask({ topic: 'P1', block: 'K2' }));
          const error = await storage.deleteBlock('P1', 'K2').catch((e: unknown) => e);
          expect((error as BoardError).details).toMatchObject({
            topic: 'P1',
            block: 'K2',
            tasks: ['T1'],
          });
        });

        it('deletes it once its tasks are gone or placed elsewhere', async () => {
          await twoTopics();
          await storage.createTask(newTask({ topic: 'P1', block: 'K2' }));
          await storage.createTask(newTask({ topic: 'P1', block: 'K2' }));
          await storage.deleteTask('T1');
          await expectCode(storage.deleteBlock('P1', 'K2'), 'BLOCK_NOT_EMPTY');
          await storage.updateTask('T2', { block: 'K1' });
          await storage.deleteBlock('P1', 'K2');
          expect(ids((await storage.getTopic('P1'))?.blocks)).toEqual(['K1', 'K3']);
        });

        it('does not look at the tasks of other blocks', async () => {
          await twoTopics();
          await storage.createTask(newTask({ topic: 'P1', block: 'K1' }));
          await storage.createTask(newTask({ topic: 'P1' }));
          await storage.deleteBlock('P1', 'K2');
          expect(ids((await storage.getTopic('P1'))?.blocks)).toEqual(['K1', 'K3']);
        });

        it('refuses a topic or a block that does not exist, and writes nothing', async () => {
          await twoTopics();
          await expectRefused(storage.deleteBlock('P9', 'K1'), 'TOPIC_NOT_FOUND');
          await expectRefused(storage.deleteBlock('P1', 'K9'), 'BLOCK_NOT_FOUND');
          await expectRefused(storage.deleteBlock('P1', 'K4'), 'BLOCK_NOT_FOUND');
        });

        it('never reuses its id once deleted (INVARIANT)', async () => {
          await twoTopics();
          await storage.deleteBlock('P2', 'K4');
          expect((await storage.createBlock('P2', { title: 'x' })).id).toBe('K5');
        });

        it.each(['missing', 'invalid'] as const)(
          'never reuses an id when the counters are %s at the time of the delete (INVARIANT)',
          async (state) => {
            await twoTopics();
            await harness.setSequence(storage, state);
            await storage.deleteBlock('P2', 'K4');
            const reopened = await reopen(storage);
            expect((await reopened.createBlock('P2', { title: 'x' })).id).toBe('K5');
          },
        );
      });

      describe('fail-closed when the counters are lost (O-1)', () => {
        it.each(['missing', 'invalid'] as const)(
          'refuses to delete a topic or a block when the counters are %s and a topic cannot be read',
          async (state) => {
            await twoTopics();
            await storage.createTopic(topic('empty'));
            await harness.breakTopic(storage, 'P2');
            await harness.setSequence(storage, state);
            await expectCode(storage.deleteBlock('P1', 'K3'), 'ID_SEQUENCE_UNRECOVERABLE');
            await expectCode(storage.deleteTopic('P3'), 'ID_SEQUENCE_UNRECOVERABLE');
            expect(ids((await storage.getTopic('P1'))?.blocks)).toEqual(['K1', 'K2', 'K3']);
            expect(await storage.getTopic('P3')).not.toBeNull();
          },
        );

        it('does not stop a delete when the counters are valid', async () => {
          await twoTopics();
          await harness.breakTopic(storage, 'P2');
          await storage.deleteBlock('P1', 'K3');
          expect(ids((await storage.getTopic('P1'))?.blocks)).toEqual(['K1', 'K2']);
        });
      });

      describe('writes are one at a time (INVARIANT)', () => {
        it('loses no block and no rename when they race', async () => {
          await twoTopics();
          await Promise.all([
            storage.createBlock('P1', { title: 'five' }),
            storage.updateBlock('P1', 'K1', { title: 'Renamed' }),
            storage.updateTopic('P1', { title: 'T' }),
            storage.createBlock('P1', { title: 'six' }),
          ]);
          const read = await storage.getTopic('P1');
          expect(ids(read?.blocks)).toEqual(['K1', 'K2', 'K3', 'K5', 'K6']);
          expect(read?.blocks[0]?.title).toBe('Renamed');
          expect(read?.title).toBe('T');
        });

        it('never leaves a task in a block that was deleted', async () => {
          for (let round = 0; round < 5; round++) {
            const created = await storage.createTopic(topic());
            const block = await storage.createBlock(created.id, { title: 'b' });
            const results = await Promise.allSettled([
              storage.deleteBlock(created.id, block.id),
              storage.createTask(newTask({ topic: created.id, block: block.id })),
            ]);
            const held = (await storage.getTopic(created.id))?.blocks.some(
              (b) => b.id === block.id,
            );
            const placed = (await storage.listTasks()).filter((t) => t.block === block.id);
            // Either the block is gone and no task is in it, or it stays with its task.
            if (held) expect(placed).toHaveLength(1);
            else expect(placed).toHaveLength(0);
            expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
          }
        });
      });
    });

    describe('task workflow overrides', () => {
      it('keeps the overrides it was given, and only those (INVARIANT)', async () => {
        const created = await storage.createTask(newTask({ workflow: { push: true } }));
        expect(created.workflow).toEqual({ push: true });
        expect((await storage.getTask(created.id))?.workflow).toEqual({ push: true });
        const reopened = await reopen(storage);
        expect((await reopened.getTask(created.id))?.workflow).toEqual({ push: true });
      });

      it('has no workflow at all for a task that was created without one', async () => {
        const created = await storage.createTask(newTask());
        expect('workflow' in created).toBe(false);
        expect('workflow' in ((await storage.getTask(created.id)) ?? {})).toBe(false);
      });

      it('replaces the whole set of overrides on update, like labels do', async () => {
        const created = await storage.createTask(
          newTask({ workflow: { push: true, checks: false } }),
        );
        const updated = await storage.updateTask(created.id, { workflow: { commit: false } });
        expect(updated.workflow).toEqual({ commit: false });
        expect((await storage.getTask(created.id))?.workflow).toEqual({ commit: false });
      });

      it('clears every override when the patch says null', async () => {
        const created = await storage.createTask(newTask({ workflow: { push: true } }));
        const updated = await storage.updateTask(created.id, { workflow: null });
        expect('workflow' in updated).toBe(false);
        expect('workflow' in ((await storage.getTask(created.id)) ?? {})).toBe(false);
      });

      it('leaves the overrides alone when the patch does not mention them', async () => {
        const created = await storage.createTask(newTask({ workflow: { push: true } }));
        const updated = await storage.updateTask(created.id, { title: 'Renamed' });
        expect(updated.workflow).toEqual({ push: true });
      });

      it('keeps the overrides when the task moves to another column', async () => {
        const created = await storage.createTask(newTask({ workflow: { push: true } }));
        const updated = await storage.updateTask(created.id, { status: 'done', rank: 'a1' });
        expect(updated.workflow).toEqual({ push: true });
      });
    });

    describe('the run of an agent on a task (aiRun, T27)', () => {
      const working = {
        agent: 'claude-code',
        state: 'working' as const,
        startedAt: '2026-09-26T10:00:00.000Z',
      };
      const finished = {
        ...working,
        state: 'finished' as const,
        checks: 'passed' as const,
        commit: '9f1c1a2',
        finishedAt: '2026-09-26T11:00:00.000Z',
      };

      it('has no run for a task no agent has reported on', async () => {
        const created = await storage.createTask(newTask());
        expect('aiRun' in created).toBe(false);
      });

      it('keeps the run an agent reported, whole, across a reopen (INVARIANT)', async () => {
        const created = await storage.createTask(newTask());
        const updated = await storage.updateTask(created.id, { aiRun: finished });
        expect(updated.aiRun).toEqual(finished);
        const reopened = await reopen(storage);
        expect((await reopened.getTask(created.id))?.aiRun).toEqual(finished);
        // It is a field of the board, not something the user wrote next to it.
        expect((await reopened.getTask(created.id))?.extra).toBeUndefined();
      });

      it('replaces the run whole: nothing of the last report lingers in the next', async () => {
        const created = await storage.createTask(newTask());
        await storage.updateTask(created.id, { aiRun: finished });
        const updated = await storage.updateTask(created.id, { aiRun: working });
        expect(updated.aiRun).toEqual(working);
        expect((await storage.getTask(created.id))?.aiRun).toEqual(working);
      });

      it('forgets the run when the patch says null, and keeps it when the patch is silent', async () => {
        const created = await storage.createTask(newTask());
        await storage.updateTask(created.id, { aiRun: working });
        expect((await storage.updateTask(created.id, { title: 'Renamed' })).aiRun).toEqual(working);
        const cleared = await storage.updateTask(created.id, { aiRun: null });
        expect('aiRun' in cleared).toBe(false);
        expect('aiRun' in ((await storage.getTask(created.id)) ?? {})).toBe(false);
      });
    });

    describe('workflow overrides of the board and its columns', () => {
      const workflow = {
        board: { push: false, checkCommand: 'npm test', finishStatus: null },
        statuses: { backlog: { editCode: false }, todo: { commit: false } },
      };

      it('is empty on a board that never had any, and that is not an error', async () => {
        expect(await storage.readWorkflow()).toEqual({ board: {}, statuses: {} });
        expect(await storage.readIssues()).toEqual([]);
      });

      it('writes and reads back exactly what it was given', async () => {
        await storage.writeWorkflow(workflow);
        expect(await storage.readWorkflow()).toEqual(workflow);
      });

      it('survives a reopen', async () => {
        await storage.writeWorkflow(workflow);
        const reopened = await reopen(storage);
        expect(await reopened.readWorkflow()).toEqual(workflow);
      });

      it('replaces the previous overrides whole: a key that is gone stays gone', async () => {
        await storage.writeWorkflow(workflow);
        await storage.writeWorkflow({ board: { push: true }, statuses: {} });
        expect(await storage.readWorkflow()).toEqual({ board: { push: true }, statuses: {} });
      });

      it('can be emptied again', async () => {
        await storage.writeWorkflow(workflow);
        await storage.writeWorkflow({ board: {}, statuses: {} });
        expect(await storage.readWorkflow()).toEqual({ board: {}, statuses: {} });
      });

      it('does not hand out, or keep, the object it was given', async () => {
        const given = structuredClone(workflow);
        await storage.writeWorkflow(given);
        given.board.push = true;
        given.statuses.todo.commit = true;
        const read = await storage.readWorkflow();
        expect(read).toEqual(workflow);
        read.board.checkCommand = 'changed';
        expect(await storage.readWorkflow()).toEqual(workflow);
      });

      it('does not touch the tasks, and they do not touch it', async () => {
        const created = await storage.createTask(newTask({ workflow: { push: true } }));
        await storage.writeWorkflow(workflow);
        expect(await storage.getTask(created.id)).toEqual(created);
        await storage.updateTask(created.id, { title: 'Renamed' });
        expect(await storage.readWorkflow()).toEqual(workflow);
      });

      it('reports no read problems for what it wrote itself', async () => {
        await storage.writeWorkflow(workflow);
        expect(await storage.readIssues()).toEqual([]);
      });
    });

    describe('documents', () => {
      let taskId: string;

      beforeEach(async () => {
        taskId = (await storage.createTask(newTask())).id;
      });

      it('writes, reads, lists and deletes', async () => {
        const meta = await storage.writeDocument(taskId, 'plan.md', '# Plan\n');
        expect(meta).toMatchObject({ taskId, name: 'plan.md', size: 7 });
        expect(await storage.readDocument(taskId, 'plan.md')).toBe('# Plan\n');
        expect(await storage.listDocuments(taskId)).toEqual([meta]);
        await storage.deleteDocument(taskId, 'plan.md');
        expect(await storage.listDocuments(taskId)).toEqual([]);
        expect(await storage.readDocument(taskId, 'plan.md')).toBeNull();
      });

      it('overwrites idempotently', async () => {
        await storage.writeDocument(taskId, 'plan.md', '# Plan\n');
        const meta = await storage.writeDocument(taskId, 'plan.md', '# Plan v2\n');
        expect(meta.size).toBe(10);
        expect(await storage.readDocument(taskId, 'plan.md')).toBe('# Plan v2\n');
        expect(await storage.listDocuments(taskId)).toHaveLength(1);
      });

      it('survives a reopen', async () => {
        await storage.writeDocument(taskId, 'plan.md', '# Plan\n');
        const reopened = await reopen(storage);
        expect(await reopened.readDocument(taskId, 'plan.md')).toBe('# Plan\n');
      });

      it.each([
        '../escape.md',
        '../../etc/passwd',
        'sub/dir.md',
        'back\\slash.md',
        'nul\0.md',
        '/absolute.md',
        '.hidden.md',
        'notes.txt',
        'task.md',
        'TASK.md',
      ])('rejects the unsafe name %p (INVARIANT 5)', async (name) => {
        await expectCode(storage.writeDocument(taskId, name, 'x'), 'INVALID_DOCUMENT_NAME');
        await expectCode(
          storage.readDocument(taskId, name) as Promise<unknown>,
          'INVALID_DOCUMENT_NAME',
        );
        await expectCode(storage.deleteDocument(taskId, name), 'INVALID_DOCUMENT_NAME');
      });

      it('deletes the documents of a deleted task (INVARIANT 4)', async () => {
        await storage.writeDocument(taskId, 'plan.md', '# Plan\n');
        await storage.deleteTask(taskId);
        await expectCode(storage.listDocuments(taskId), 'TASK_NOT_FOUND');
        const next = await storage.createTask(newTask());
        expect(await storage.listDocuments(next.id)).toEqual([]);
      });

      it('refuses documents of a task that does not exist', async () => {
        await expectCode(storage.writeDocument('T404', 'plan.md', 'x'), 'TASK_NOT_FOUND');
        await expectCode(storage.listDocuments('T404'), 'TASK_NOT_FOUND');
      });

      it('returns null for a document that does not exist, and refuses to delete it', async () => {
        expect(await storage.readDocument(taskId, 'missing.md')).toBeNull();
        await expectCode(storage.deleteDocument(taskId, 'missing.md'), 'DOCUMENT_NOT_FOUND');
      });

      it('lists documents by name, the same order for every provider', async () => {
        await storage.writeDocument(taskId, 'plan.md', 'x');
        await storage.writeDocument(taskId, 'audit.html', 'x');
        await storage.writeDocument(taskId, 'notes.md', 'x');
        expect((await storage.listDocuments(taskId)).map((d) => d.name)).toEqual([
          'audit.html',
          'notes.md',
          'plan.md',
        ]);
      });

      it('round-trips html documents and unicode', async () => {
        await storage.writeDocument(taskId, 'report.html', '<p>Ünïcode 🎯</p>\n');
        expect(await storage.readDocument(taskId, 'report.html')).toBe('<p>Ünïcode 🎯</p>\n');
      });
    });

    describe('reports', () => {
      it('writes, reads, lists and deletes', async () => {
        const report = await storage.writeReport({
          title: 'Dependency audit',
          format: 'html',
          content: '<h1>Audit</h1>\n',
        });
        expect(report).toMatchObject({ title: 'Dependency audit', format: 'html' });
        expect(await storage.readReport(report.id)).toBe('<h1>Audit</h1>\n');
        expect(await storage.listReports()).toEqual([report]);
        await storage.deleteReport(report.id);
        expect(await storage.listReports()).toEqual([]);
        expect(await storage.readReport(report.id)).toBeNull();
      });

      it('never reuses a report id and survives a reopen', async () => {
        const first = await storage.writeReport({ title: 'A', format: 'md', content: '# A\n' });
        await storage.deleteReport(first.id);
        const reopened = await reopen(storage);
        const second = await reopened.writeReport({ title: 'B', format: 'md', content: '# B\n' });
        expect(second.id).not.toBe(first.id);
        expect(await reopened.readReport(second.id)).toBe('# B\n');
      });

      it('refuses to read or delete a report that does not exist', async () => {
        expect(await storage.readReport('R404')).toBeNull();
        await expectCode(storage.deleteReport('R404'), 'REPORT_NOT_FOUND');
      });
    });

    describe('history (ADR-0030)', () => {
      const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';
      const snapshot = { title: 'T', body: 'body\n', labels: ['a'] };
      const version = (over: Partial<Parameters<Storage['appendVersion']>[1]> = {}) => ({
        source: 'edit' as const,
        changed: ['body' as const],
        snapshot,
        ...over,
      });
      const reportContent = (over: object = {}) => ({
        agent: 'claude-code',
        verdict: 'current' as const,
        summary: 'Fine.',
        findings: [],
        recommendations: [
          { id: 'r1', findings: [], text: 'Do it.', edit: { field: 'title' as const, value: 'N' } },
        ],
        version: 1,
        repo: null,
        ...over,
      });
      let taskId: string;

      beforeEach(async () => {
        taskId = (await storage.createTask(newTask())).id;
      });

      async function begun(): Promise<number> {
        await storage.appendVersion(taskId, version({ source: 'baseline', changed: [] }));
        return (
          await storage.beginCheck(taskId, {
            version: 1,
            agent: 'claude-code',
            sessionId: SESSION,
            repo: { branch: 'main', head: '9f1c1a2b', clean: true },
          })
        ).number;
      }

      it('numbers versions per task from 1, in order, and reads them back (INVARIANT)', async () => {
        const other = (await storage.createTask(newTask())).id;
        const first = await storage.appendVersion(
          taskId,
          version({ source: 'baseline', changed: [] }),
        );
        const second = await storage.appendVersion(taskId, version());
        const foreign = await storage.appendVersion(
          other,
          version({ source: 'create', changed: [] }),
        );

        expect([first.number, second.number, foreign.number]).toEqual([1, 2, 1]);
        expect(await storage.listVersions(taskId)).toEqual([first, second]);
        expect(await storage.readVersion(taskId, 2)).toEqual(second);
        expect(await storage.readVersion(taskId, 3)).toBeNull();
        expect(first).toMatchObject({ taskId, source: 'baseline', snapshot });
      });

      it('keeps restoredFrom and fromCheck on the version', async () => {
        const fromCheck = { check: 1, recommendations: ['r1'], basis: 'report' as const };
        const saved = await storage.appendVersion(
          taskId,
          version({ source: 'restore', restoredFrom: 1, fromCheck }),
        );
        expect(await storage.readVersion(taskId, saved.number)).toMatchObject({
          restoredFrom: 1,
          fromCheck,
        });
      });

      it('keeps its numbers across a reopen: a number is never given twice', async () => {
        await storage.appendVersion(taskId, version());
        await storage.appendVersion(taskId, version());
        const reopened = await reopen(storage);
        expect((await reopened.appendVersion(taskId, version())).number).toBe(3);
        expect((await reopened.listVersions(taskId)).map((v) => v.number)).toEqual([1, 2, 3]);
      });

      it('has no way to change or remove a record: a returned version is a copy', async () => {
        const saved = await storage.appendVersion(taskId, version());
        saved.snapshot.title = 'tampered';
        expect((await storage.readVersion(taskId, 1))?.snapshot.title).toBe('T');
      });

      it('does not offer history for a task that does not exist', async () => {
        await expectCode(storage.appendVersion('T404', version()), 'TASK_NOT_FOUND');
        await expectCode(storage.listVersions('T404'), 'TASK_NOT_FOUND');
        await expectCode(storage.listChecks('T404'), 'TASK_NOT_FOUND');
      });

      it('numbers checks per task, and reads one with its state derived (INVARIANT)', async () => {
        const number = await begun();
        expect(number).toBe(1);
        expect(await storage.readCheck(taskId, 1)).toMatchObject({
          state: 'working',
          begin: { version: 1, agent: 'claude-code', sessionId: SESSION },
          decisions: [],
        });
        expect(await storage.readCheck(taskId, 2)).toBeNull();
        const second = await storage.beginCheck(taskId, {
          version: 1,
          agent: 'claude-code',
          sessionId: SESSION,
          model: 'opus',
          repo: null,
        });
        expect(second.number).toBe(2);
        expect((await storage.listChecks(taskId)).map((c) => c.begin.number)).toEqual([1, 2]);
      });

      it('takes one report of a working check and refuses a second (INVARIANT)', async () => {
        const number = await begun();
        const report = await storage.writeCheckReport(taskId, number, reportContent());
        expect(report).toMatchObject({ taskId, check: number, verdict: 'current', version: 1 });
        expect((await storage.readCheck(taskId, number))?.state).toBe('reported');

        await expectCode(
          storage.writeCheckReport(taskId, number, reportContent({ summary: 'Other.' })),
          'CHECK_ALREADY_FINAL',
        );
        expect((await storage.readCheck(taskId, number))?.report?.summary).toBe('Fine.');
      });

      it('takes one end and refuses a second; an end after a report keeps it reported (INVARIANT)', async () => {
        const number = await begun();
        await storage.writeCheckReport(taskId, number, reportContent());
        const end = await storage.endCheck(taskId, number, { sessionId: SESSION, exitCode: 0 });
        expect(end).toMatchObject({ check: number, sessionId: SESSION, exitCode: 0 });
        expect((await storage.readCheck(taskId, number))?.state).toBe('reported');
        await expectCode(
          storage.endCheck(taskId, number, { sessionId: SESSION }),
          'CHECK_ALREADY_FINAL',
        );
      });

      it('calls a check with an end and no report failed, and takes no report after it', async () => {
        const number = await begun();
        await storage.endCheck(taskId, number, { sessionId: SESSION, exitCode: 1 });
        expect((await storage.readCheck(taskId, number))?.state).toBe('failed');
        await expectCode(
          storage.writeCheckReport(taskId, number, reportContent()),
          'CHECK_ALREADY_FINAL',
        );
      });

      it('refuses a report, an end or a decision for a check that does not exist', async () => {
        await expectCode(storage.writeCheckReport(taskId, 9, reportContent()), 'CHECK_NOT_FOUND');
        await expectCode(storage.endCheck(taskId, 9, { sessionId: SESSION }), 'CHECK_NOT_FOUND');
        await expectCode(
          storage.appendDecision(taskId, 9, { recommendation: 'r1', decision: 'accepted' }),
          'CHECK_NOT_FOUND',
        );
      });

      it('appends decisions and keeps all of them, in order', async () => {
        const number = await begun();
        await storage.writeCheckReport(taskId, number, reportContent());
        const first = await storage.appendDecision(taskId, number, {
          recommendation: 'r1',
          decision: 'accepted',
        });
        const second = await storage.appendDecision(taskId, number, {
          recommendation: 'r1',
          decision: 'rejected',
          note: 'changed my mind',
        });
        expect([first.number, second.number]).toEqual([1, 2]);
        expect((await storage.readCheck(taskId, number))?.decisions).toEqual([first, second]);
      });

      it('keeps the numbers of checks and decisions across a reopen', async () => {
        const number = await begun();
        await storage.appendDecision(taskId, number, {
          recommendation: 'r1',
          decision: 'accepted',
        });
        const reopened = await reopen(storage);
        expect(
          (
            await reopened.beginCheck(taskId, {
              version: 1,
              agent: 'a',
              sessionId: SESSION,
              repo: null,
            })
          ).number,
        ).toBe(2);
        expect(
          (
            await reopened.appendDecision(taskId, number, {
              recommendation: 'r1',
              decision: 'rejected',
            })
          ).number,
        ).toBe(2);
      });

      it('stores a report as it was sent', async () => {
        const number = await begun();
        const content = reportContent({
          uncertainty: 'Could not read the build output.',
          findings: [
            {
              id: 'f1',
              title: 'Stale',
              explanation: 'The text names a file that moved.',
              evidence: [{ kind: 'file', ref: 'src/a.ts', note: 'moved to src/b.ts' }],
            },
          ],
        });
        await storage.writeCheckReport(taskId, number, content);
        expect((await storage.readCheck(taskId, number))?.report).toMatchObject({
          uncertainty: 'Could not read the build output.',
          findings: content.findings,
          recommendations: content.recommendations,
        });
      });

      it('does not show history files as documents of the task (INVARIANT)', async () => {
        await begun();
        await storage.writeDocument(taskId, 'plan.md', '# Plan\n');
        expect((await storage.listDocuments(taskId)).map((d) => d.name)).toEqual(['plan.md']);
      });

      it('deletes the history with the task, and a new task has none (INVARIANT)', async () => {
        await begun();
        await storage.deleteTask(taskId);
        await expectCode(storage.listVersions(taskId), 'TASK_NOT_FOUND');
        const next = (await storage.createTask(newTask())).id;
        expect(next).not.toBe(taskId);
        expect(await storage.listVersions(next)).toEqual([]);
        expect(await storage.listChecks(next)).toEqual([]);
      });

      describe('research (ADR-0030 R1–R3)', () => {
        const researchContent = (over: object = {}) => ({
          agent: 'claude-code',
          summary: 'Clear.',
          findings: [],
          recommendations: [
            {
              id: 'r1',
              findings: [],
              text: 'Mention the API.',
              targets: [{ kind: 'file' as const, ref: 'src/api.ts' }],
            },
          ],
          markdown: '# Research\n\nThe API is stable. Ünï\n',
          version: 1,
          repo: null,
          ...over,
        });

        async function beginResearch(over: object = {}): Promise<number> {
          return (
            await storage.beginCheck(taskId, {
              version: 1,
              agent: 'claude-code',
              sessionId: SESSION,
              repo: null,
              kind: 'research',
              comment: 'Focus on the API.',
              documents: [{ name: 'plan.md', size: 7, updatedAt: '2026-10-24T10:00:00.000Z' }],
              ...over,
            })
          ).number;
        }

        it('keeps kind, comment and documents on the begin, and reads a begin without them as before', async () => {
          await begun();
          const number = await beginResearch();
          expect((await storage.readCheck(taskId, number))?.begin).toMatchObject({
            kind: 'research',
            comment: 'Focus on the API.',
            documents: [{ name: 'plan.md', size: 7, updatedAt: '2026-10-24T10:00:00.000Z' }],
          });
          const first = (await storage.readCheck(taskId, 1))?.begin;
          expect(first).not.toHaveProperty('kind');
          expect(first).not.toHaveProperty('comment');
          expect(first).not.toHaveProperty('documents');
        });

        it('numbers research and actuality checks of one task in one series; #1 is the same after #2 (INVARIANT)', async () => {
          await begun();
          await storage.writeCheckReport(taskId, 1, reportContent());
          const before = await storage.readCheck(taskId, 1);
          const second = await beginResearch();
          await storage.writeCheckReport(taskId, second, researchContent());
          const third = await beginResearch({ comment: 'Another focus.' });

          expect([second, third]).toEqual([2, 3]);
          expect(await storage.readCheck(taskId, 1)).toEqual(before);
          expect((await storage.listChecks(taskId)).map((c) => c.begin.number)).toEqual([1, 2, 3]);
          expect((await storage.readCheck(taskId, 3))?.begin.comment).toBe('Another focus.');
          expect((await storage.readCheck(taskId, 2))?.begin.comment).toBe('Focus on the API.');

          const reopened = await reopen(storage);
          expect(await reopened.readCheck(taskId, 1)).toEqual(before);
          expect(await reopened.readCheck(taskId, 2)).toEqual(await storage.readCheck(taskId, 2));
        });

        it('keeps the markdown of research #1 byte for byte after research #2 is written (INVARIANT)', async () => {
          const first = await beginResearch();
          const firstContent = researchContent({ markdown: '# First\n\nOne.\n' });
          await storage.writeCheckReport(taskId, first, firstContent);
          const before = await storage.readCheck(taskId, first);

          const second = await beginResearch({ comment: 'Another focus.' });
          await storage.writeCheckReport(
            taskId,
            second,
            researchContent({ markdown: '# Second\n\nTwo.\n' }),
          );

          expect(await storage.readCheck(taskId, first)).toEqual(before);
          expect(await storage.readCheckMarkdown(taskId, first)).toBe(firstContent.markdown);
          expect(await storage.readCheckMarkdown(taskId, second)).toBe('# Second\n\nTwo.\n');
        });

        it('stores the markdown apart from the record, which holds its size and hash only', async () => {
          const number = await beginResearch();
          const content = researchContent();
          const report = await storage.writeCheckReport(taskId, number, content);
          expect(report).not.toHaveProperty('verdict');
          expect(report).not.toHaveProperty('markdown', content.markdown);
          expect(report.markdown?.bytes).toBe(Buffer.byteLength(content.markdown, 'utf8'));
          expect(report.markdown?.hash).toMatch(/^[0-9a-f]{16}$/);
          expect(report.recommendations).toEqual(content.recommendations);
          expect(await storage.readCheckMarkdown(taskId, number)).toBe(content.markdown);
          expect((await storage.readCheck(taskId, number))?.state).toBe('reported');
          expect((await storage.listChecks(taskId))[0]?.report).toEqual(report);
        });

        it('takes the markdown once: a second report is refused and the text stays (INVARIANT)', async () => {
          const number = await beginResearch();
          await storage.writeCheckReport(taskId, number, researchContent());
          const stored = await storage.readCheck(taskId, number);

          await expectCode(
            storage.writeCheckReport(taskId, number, researchContent({ markdown: '# Other\n' })),
            'CHECK_ALREADY_FINAL',
          );
          await expectCode(
            storage.writeCheckReport(taskId, number, researchContent()),
            'CHECK_ALREADY_FINAL',
          );
          expect(await storage.readCheckMarkdown(taskId, number)).toBe(researchContent().markdown);
          expect(await storage.readCheck(taskId, number)).toEqual(stored);
        });

        it('does not publish a markdown that has no record: the research stays working', async () => {
          const number = await beginResearch();
          await harness.strandMarkdown(storage, taskId, number, '# Half\n');
          expect((await storage.readCheck(taskId, number))?.state).toBe('working');
          expect((await storage.readCheck(taskId, number))?.report).toBeUndefined();
          expect(await storage.readCheckMarkdown(taskId, number)).toBeNull();
          expect(await storage.readIssues()).toEqual([]);
        });

        it('finishes a half-written report when the same bytes come again (INVARIANT)', async () => {
          const number = await beginResearch();
          await harness.strandMarkdown(storage, taskId, number, researchContent().markdown);

          const report = await storage.writeCheckReport(taskId, number, researchContent());
          expect(report.markdown?.bytes).toBe(Buffer.byteLength(researchContent().markdown));
          expect((await storage.readCheck(taskId, number))?.state).toBe('reported');
          expect(await storage.readCheckMarkdown(taskId, number)).toBe(researchContent().markdown);
        });

        it('refuses other bytes after a half-written report, writes nothing, and a later repeat still finishes (INVARIANT)', async () => {
          const number = await beginResearch();
          await harness.strandMarkdown(storage, taskId, number, '# First\n');

          await expectCode(
            storage.writeCheckReport(taskId, number, researchContent({ markdown: '# Second\n' })),
            'CHECK_ALREADY_FINAL',
          );
          const state = await storage.readCheck(taskId, number);
          expect(state?.state).toBe('working');
          expect(state?.report).toBeUndefined();
          expect(await storage.readCheckMarkdown(taskId, number)).toBeNull();

          await storage.writeCheckReport(
            taskId,
            number,
            researchContent({ markdown: '# First\n' }),
          );
          expect(await storage.readCheckMarkdown(taskId, number)).toBe('# First\n');
        });

        it('refuses a report of the wrong kind and an oversized one, and writes nothing', async () => {
          await begun();
          const research = await beginResearch();
          await expectCode(
            storage.writeCheckReport(taskId, 1, researchContent()),
            'INVALID_CHECK_REPORT',
          );
          await expectCode(
            storage.writeCheckReport(taskId, research, reportContent()),
            'INVALID_CHECK_REPORT',
          );
          await expectCode(
            storage.writeCheckReport(
              taskId,
              research,
              researchContent({ markdown: 'x'.repeat(200_001) }),
            ),
            'INVALID_CHECK_REPORT',
          );
          expect((await storage.readCheck(taskId, 1))?.state).toBe('working');
          expect((await storage.readCheck(taskId, research))?.state).toBe('working');
          // Nothing was left behind by the refusals: the same text can still be written.
          await storage.writeCheckReport(taskId, research, researchContent());
          expect(await storage.readCheckMarkdown(taskId, research)).toBe(
            researchContent().markdown,
          );
        });

        it('has no markdown to read for an actuality check or a check that does not exist', async () => {
          const number = await begun();
          await storage.writeCheckReport(taskId, number, reportContent());
          expect(await storage.readCheckMarkdown(taskId, number)).toBeNull();
          expect(await storage.readCheckMarkdown(taskId, 99)).toBeNull();
        });

        it('does not show the report as a document of the task (INVARIANT)', async () => {
          const number = await beginResearch();
          await storage.writeCheckReport(taskId, number, researchContent());
          await storage.writeDocument(taskId, 'plan.md', '# Plan\n');
          expect((await storage.listDocuments(taskId)).map((d) => d.name)).toEqual(['plan.md']);
          expect(await storage.readDocument(taskId, 'report.md')).toBeNull();
        });

        it('deletes the research with the task, markdown included (INVARIANT)', async () => {
          const number = await beginResearch();
          await storage.writeCheckReport(taskId, number, researchContent());
          await storage.deleteTask(taskId);
          await expectCode(storage.listChecks(taskId), 'TASK_NOT_FOUND');
          const next = (await storage.createTask(newTask())).id;
          expect(await storage.listChecks(next)).toEqual([]);
          expect(await storage.readCheckMarkdown(next, number)).toBeNull();
        });
      });
    });
  });
}
