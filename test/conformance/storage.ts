import { BoardError } from '../../src/core/errors.js';
import { taskSchema } from '../../src/core/model/index.js';
import type { NewTask, Storage } from '../../src/core/ports.js';

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

      it('is idempotent on a second init (INVARIANT 7)', async () => {
        const created = await storage.createTask(newTask());
        await storage.init();
        expect(await storage.listTasks()).toEqual([created]);
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
  });
}
