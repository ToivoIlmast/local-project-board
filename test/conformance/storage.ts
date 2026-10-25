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
  /**
   * Leaves a research with its `report.md` written and no record after it: the process ended
   * between the two writes (ADR-0030 R3). Only the provider knows what that looks like.
   */
  strandMarkdown(storage: Storage, taskId: string, number: number, markdown: string): Promise<void>;
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
