import type { BoardError } from '../../../src/core/errors.js';
import type { CheckReportContent, ResearchReportContent } from '../../../src/core/model/index.js';
import type { Storage } from '../../../src/core/ports.js';
import { contentHash } from '../../../src/core/rules/history.js';
import { createHistoryService, type HistoryService } from '../../../src/core/services/history.js';
import { createTaskLocks } from '../../../src/core/services/taskLocks.js';
import { createTaskService, type TaskService } from '../../../src/core/services/tasks.js';
import { recordingEventSink, type RecordingEventSink } from '../../support/events.js';
import { createMemoryStore, inMemoryStorage } from '../../support/inMemoryStorage.js';

const statuses = ['backlog', 'todo', 'in-progress', 'done'];
const SESSION = 'a1b2c3d4-e5f6-4890-abcd-ef0123456789';

describe('task history', () => {
  let storage: Storage;
  let events: RecordingEventSink;
  let tasks: TaskService;
  let history: HistoryService;

  beforeEach(async () => {
    storage = inMemoryStorage(createMemoryStore());
    await storage.init();
    events = recordingEventSink();
    const locks = createTaskLocks();
    tasks = createTaskService({ storage, events, statuses, locks });
    history = createHistoryService({ storage, events, locks });
  });

  async function code(action: Promise<unknown>): Promise<string> {
    return action.then(
      () => 'no error',
      (error: unknown) => (error as BoardError).code,
    );
  }

  const numbers = async (id: string): Promise<number[]> =>
    (await storage.listVersions(id)).map((version) => version.number);

  /** A task as an earlier board left it: with content and no history at all. */
  async function legacy(over: { title?: string; body?: string; labels?: string[] } = {}) {
    return storage.createTask({
      title: over.title ?? 'Legacy',
      status: 'todo',
      rank: 'a0',
      body: over.body ?? 'old\n',
      labels: over.labels ?? ['x'],
    });
  }

  describe('versions', () => {
    it('makes the first version when a task is created', async () => {
      const task = await tasks.create({ title: 'One', body: 'text\n', labels: ['a'] });
      const [version] = await storage.listVersions(task.id);
      expect(version).toMatchObject({
        number: 1,
        source: 'create',
        changed: [],
        snapshot: { title: 'One', body: 'text\n', labels: ['a'] },
      });
    });

    it('makes a version of a changed title, body or labels, and names what changed (INVARIANT)', async () => {
      const task = await tasks.create({ title: 'One' });
      await tasks.update(task.id, { title: 'Two' });
      await tasks.update(task.id, { body: 'b', labels: ['l'] });
      const versions = await storage.listVersions(task.id);
      expect(versions.map((v) => [v.source, v.changed])).toEqual([
        ['create', []],
        ['edit', ['title']],
        ['edit', ['body', 'labels']],
      ]);
      expect(versions[2]?.snapshot).toEqual({ title: 'Two', body: 'b', labels: ['l'] });
    });

    it.each([
      ['equal content', { title: 'One', body: '', labels: [] }],
      ['a status only', { status: 'done' }],
      ['a branch only', { branch: 'feat/x' }],
    ])('makes no version of %s (INVARIANT)', async (_name, patch) => {
      const task = await tasks.create({ title: 'One' });
      await tasks.update(task.id, patch);
      expect(await numbers(task.id)).toEqual([1]);
    });

    it('makes none of a move, of workflow settings or of a run (INVARIANT)', async () => {
      const task = await tasks.create({ title: 'One' });
      await tasks.move(task.id, { status: 'done' });
      await tasks.update(task.id, { workflow: { push: true } });
      await tasks.update(task.id, { aiRun: { agent: 'a', state: 'working' } });
      expect(await numbers(task.id)).toEqual([1]);
    });

    it('records a baseline before the first write of a task that has no history', async () => {
      const task = await legacy();
      await tasks.update(task.id, { body: 'new\n' });
      const versions = await storage.listVersions(task.id);
      expect(versions.map((v) => [v.number, v.source, v.snapshot.body])).toEqual([
        [1, 'baseline', 'old\n'],
        [2, 'edit', 'new\n'],
      ]);
      expect(versions[0]?.changed).toEqual([]);
    });

    it('makes a baseline for nothing but a content write: a status change leaves no history', async () => {
      const task = await legacy();
      await tasks.update(task.id, { status: 'done' });
      expect(await numbers(task.id)).toEqual([]);
    });

    it('records content changed outside the server as external, before the edit (INVARIANT)', async () => {
      const task = await tasks.create({ title: 'One', body: 'a\n' });
      await storage.updateTask(task.id, { body: 'edited in an editor\n' });
      await tasks.update(task.id, { title: 'Two' });
      const versions = await storage.listVersions(task.id);
      expect(versions.map((v) => [v.source, v.changed])).toEqual([
        ['create', []],
        ['external', ['body']],
        ['edit', ['title']],
      ]);
      expect(versions[1]?.snapshot.body).toBe('edited in an editor\n');
    });

    it('announces the versions it made before the task', async () => {
      const task = await legacy();
      await tasks.update(task.id, { body: 'new\n' });
      expect(events.types()).toEqual(['version.created', 'version.created', 'task.updated']);
      expect(events.events.filter((e) => e.type === 'version.created')).toEqual([
        { type: 'version.created', taskId: task.id, number: 1 },
        { type: 'version.created', taskId: task.id, number: 2 },
      ]);
    });

    it('says in the list whether the task is at its latest version, and does not write (INVARIANT)', async () => {
      const task = await tasks.create({ title: 'One' });
      const first = await history.versions(task.id);
      expect(first.current).toEqual({
        hash: contentHash({ title: 'One', body: '', labels: [] }),
        version: 1,
      });

      await storage.updateTask(task.id, { body: 'outside\n' });
      const second = await history.versions(task.id);
      expect(second.current.version).toBeNull();
      expect(second.versions).toHaveLength(1);
      expect(await numbers(task.id)).toEqual([1]);
    });

    it('lists versions without their snapshots, with the hash of each', async () => {
      const task = await tasks.create({ title: 'One' });
      const { versions } = await history.versions(task.id);
      expect(versions[0]).not.toHaveProperty('snapshot');
      expect(versions[0]?.hash).toBe(contentHash({ title: 'One', body: '', labels: [] }));
    });

    it('says VERSION_NOT_FOUND and TASK_NOT_FOUND', async () => {
      const task = await tasks.create({ title: 'One' });
      expect(await code(history.version(task.id, 9))).toBe('VERSION_NOT_FOUND');
      expect(await code(history.version('T404', 1))).toBe('TASK_NOT_FOUND');
      expect(await code(history.versions('T404'))).toBe('TASK_NOT_FOUND');
    });
  });

  describe('ifContentHash', () => {
    it('lets a change through when the content is the one it was based on', async () => {
      const task = await tasks.create({ title: 'One' });
      const hash = contentHash({ title: 'One', body: '', labels: [] });
      const updated = await tasks.update(task.id, { title: 'Two', ifContentHash: hash });
      expect(updated.title).toBe('Two');
    });

    it('refuses a content that moved on, with the current hash, and writes nothing (INVARIANT)', async () => {
      const task = await legacy();
      const stale = contentHash({ title: 'Legacy', body: 'old\n', labels: ['x'] });
      await storage.updateTask(task.id, { body: 'moved\n' });

      const error = await tasks
        .update(task.id, { title: 'Mine', ifContentHash: stale })
        .catch((e: unknown) => e as BoardError);
      expect(error).toMatchObject({
        code: 'TASK_CONTENT_CHANGED',
        details: {
          currentHash: contentHash({ title: 'Legacy', body: 'moved\n', labels: ['x'] }),
          latestVersion: null,
        },
      });
      expect((await tasks.get(task.id)).title).toBe('Legacy');
      // Not even the sync: no baseline, no external.
      expect(await numbers(task.id)).toEqual([]);
      expect(events.events).toEqual([]);
    });

    it('is checked for a change of the status alone too (INVARIANT)', async () => {
      const task = await tasks.create({ title: 'One' });
      expect(
        await code(tasks.update(task.id, { status: 'done', ifContentHash: 'f'.repeat(16) })),
      ).toBe('TASK_CONTENT_CHANGED');
      expect((await tasks.get(task.id)).status).toBe('backlog');
    });

    it('stays last-write-wins when it is absent', async () => {
      const task = await tasks.create({ title: 'One' });
      await storage.updateTask(task.id, { body: 'someone else\n' });
      const updated = await tasks.update(task.id, { title: 'Two' });
      expect(updated).toMatchObject({ title: 'Two', body: 'someone else\n' });
    });

    it('lets two saves based on the same content make one version, and refuses the other (INVARIANT)', async () => {
      const task = await tasks.create({ title: 'One' });
      const hash = contentHash({ title: 'One', body: '', labels: [] });
      const results = await Promise.all([
        code(tasks.update(task.id, { title: 'A', ifContentHash: hash })),
        code(tasks.update(task.id, { title: 'B', ifContentHash: hash })),
      ]);
      expect(results.sort()).toEqual(['TASK_CONTENT_CHANGED', 'no error']);
      expect(await numbers(task.id)).toEqual([1, 2]);
    });

    it('does not stop a change that carries no content: the precondition is about content only', async () => {
      const task = await tasks.create({ title: 'One' });
      const hash = contentHash({ title: 'One', body: '', labels: [] });
      await tasks.update(task.id, { title: 'Two' });
      // A status change with the old hash is refused; one without a hash goes through.
      expect(await code(tasks.update(task.id, { status: 'done', ifContentHash: hash }))).toBe(
        'TASK_CONTENT_CHANGED',
      );
      expect((await tasks.update(task.id, { status: 'done' })).status).toBe('done');
    });
  });

  describe('restore', () => {
    it('writes the snapshot as the content, as a new version, and keeps the status (INVARIANT)', async () => {
      const task = await tasks.create({ title: 'One', body: 'first\n', labels: ['a'] });
      await tasks.update(task.id, {
        title: 'Two',
        body: 'second\n',
        labels: ['b'],
        status: 'done',
      });
      const current = await tasks.get(task.id);

      const result = await history.restore(task.id, 1, {
        ifContentHash: contentHash(current),
      });

      expect(result.changed).toBe(true);
      expect(result.task).toMatchObject({
        title: 'One',
        body: 'first\n',
        labels: ['a'],
        status: 'done',
      });
      const versions = await storage.listVersions(task.id);
      expect(versions).toHaveLength(3);
      expect(versions[2]).toMatchObject({
        number: 3,
        source: 'restore',
        restoredFrom: 1,
        changed: ['title', 'body', 'labels'],
      });
      // The versions before it are as they were.
      expect(versions[1]?.snapshot.title).toBe('Two');
    });

    it('writes nothing when the content is already the one asked for', async () => {
      const task = await tasks.create({ title: 'One' });
      const before = events.events.length;
      const result = await history.restore(task.id, 1, {
        ifContentHash: contentHash(task),
      });
      expect(result.changed).toBe(false);
      expect(await numbers(task.id)).toEqual([1]);
      expect(events.events).toHaveLength(before);
    });

    it('needs the content it was based on, and a version that exists', async () => {
      const task = await tasks.create({ title: 'One' });
      await tasks.update(task.id, { title: 'Two' });
      expect(await code(history.restore(task.id, 1, { ifContentHash: '0'.repeat(16) }))).toBe(
        'TASK_CONTENT_CHANGED',
      );
      expect(
        await code(
          history.restore(task.id, 9, { ifContentHash: contentHash(await tasks.get(task.id)) }),
        ),
      ).toBe('VERSION_NOT_FOUND');
      expect((await tasks.get(task.id)).title).toBe('Two');
      expect(await numbers(task.id)).toEqual([1, 2]);
    });

    it('records what was outside the history first, as external', async () => {
      const task = await tasks.create({ title: 'One' });
      await storage.updateTask(task.id, { body: 'outside\n' });
      const current = await tasks.get(task.id);
      await history.restore(task.id, 1, { ifContentHash: contentHash(current) });
      expect((await storage.listVersions(task.id)).map((v) => v.source)).toEqual([
        'create',
        'external',
        'restore',
      ]);
    });

    it('does not touch the checks or their reports', async () => {
      const task = await tasks.create({ title: 'One' });
      const { number } = await history.beginCheck(task.id, {
        agent: 'claude-code',
        sessionId: SESSION,
      });
      await tasks.update(task.id, { title: 'Two' });
      await history.restore(task.id, 1, { ifContentHash: contentHash(await tasks.get(task.id)) });
      expect((await history.check(task.id, number)).state).toBe('working');
    });
  });

  describe('checks', () => {
    const report = (over: Partial<CheckReportContent> = {}): CheckReportContent => ({
      agent: 'claude-code',
      verdict: 'partly-outdated',
      summary: 'Partly.',
      findings: [
        { id: 'f1', title: 'F', explanation: 'E', evidence: [{ kind: 'file', ref: 'a.ts' }] },
      ],
      recommendations: [
        {
          id: 'r1',
          findings: ['f1'],
          text: 'Rename it.',
          edit: { field: 'title', value: 'Renamed' },
        },
        { id: 'r2', findings: [], text: 'Think about it.' },
      ],
      ...over,
    });

    it('begins on a version that exists and equals what is on disk (INVARIANT)', async () => {
      const task = await legacy();
      const begun = await history.beginCheck(task.id, { agent: 'claude-code', sessionId: SESSION });
      expect(begun).toEqual({ number: 1, version: 1 });
      expect((await storage.listVersions(task.id))[0]).toMatchObject({ source: 'baseline' });

      await storage.updateTask(task.id, { body: 'outside\n' });
      const next = await history.beginCheck(task.id, { agent: 'claude-code', sessionId: SESSION });
      expect(next).toEqual({ number: 2, version: 2 });
      expect((await storage.listVersions(task.id))[1]).toMatchObject({ source: 'external' });
    });

    it('does not read or write the run of the task, nor the task (INVARIANT)', async () => {
      const task = await tasks.create({ title: 'One' });
      await tasks.update(task.id, { aiRun: { agent: 'a', state: 'working', runId: 1 } });
      const before = await tasks.get(task.id);
      const { number } = await history.beginCheck(task.id, {
        agent: 'claude-code',
        sessionId: SESSION,
      });
      await history.report(task.id, number, report({ recommendations: [] }));
      await history.endCheck(task.id, number, { sessionId: SESSION, exitCode: 0 });
      expect(await tasks.get(task.id)).toEqual(before);
    });

    it('takes a report that holds against the checked version, once (INVARIANT)', async () => {
      const task = await tasks.create({ title: 'One' });
      const { number } = await history.beginCheck(task.id, {
        agent: 'claude-code',
        sessionId: SESSION,
      });
      const checked = await history.report(task.id, number, report());
      expect(checked).toMatchObject({
        state: 'reported',
        report: { verdict: 'partly-outdated', version: 1 },
      });
      expect(await code(history.report(task.id, number, report()))).toBe('CHECK_ALREADY_FINAL');
    });

    it('refuses a report that does not hold, with INVALID_CHECK_REPORT, and stays working', async () => {
      const task = await tasks.create({ title: 'One', body: 'x x' });
      const { number } = await history.beginCheck(task.id, {
        agent: 'claude-code',
        sessionId: SESSION,
      });
      const bad = report({
        recommendations: [
          { id: 'r1', findings: [], text: 't', edit: { field: 'body', find: 'x', replace: 'y' } },
        ],
      });
      const error = await history
        .report(task.id, number, bad)
        .catch((e: unknown) => e as BoardError);
      expect(error).toMatchObject({ code: 'INVALID_CHECK_REPORT' });
      expect((await history.check(task.id, number)).state).toBe('working');
      expect(await history.report(task.id, number, report({ recommendations: [] }))).toMatchObject({
        state: 'reported',
      });
    });

    it('validates the report against the pinned version, not against the task now', async () => {
      const task = await tasks.create({ title: 'One', body: 'one\n' });
      const { number } = await history.beginCheck(task.id, {
        agent: 'claude-code',
        sessionId: SESSION,
      });
      await tasks.update(task.id, { body: 'two\n' });
      const sent = report({
        recommendations: [
          { id: 'r1', findings: [], text: 't', edit: { field: 'body', find: 'one', replace: '1' } },
        ],
      });
      expect(await history.report(task.id, number, sent)).toMatchObject({ state: 'reported' });
    });

    it('takes an end once, from its own session only', async () => {
      const task = await tasks.create({ title: 'One' });
      const { number } = await history.beginCheck(task.id, {
        agent: 'claude-code',
        sessionId: SESSION,
      });
      expect(
        await code(
          history.endCheck(task.id, number, { sessionId: 'b1b2c3d4-e5f6-4890-abcd-ef0123456789' }),
        ),
      ).toBe('STALE_CHECK');
      expect(
        await history.endCheck(task.id, number, { sessionId: SESSION, exitCode: 2 }),
      ).toMatchObject({
        state: 'failed',
      });
      expect(await code(history.endCheck(task.id, number, { sessionId: SESSION }))).toBe(
        'CHECK_ALREADY_FINAL',
      );
    });

    it('takes no report after the end of a check that had none', async () => {
      const task = await tasks.create({ title: 'One' });
      const { number } = await history.beginCheck(task.id, {
        agent: 'claude-code',
        sessionId: SESSION,
      });
      await history.endCheck(task.id, number, { sessionId: SESSION });
      expect(await code(history.report(task.id, number, report()))).toBe('CHECK_ALREADY_FINAL');
    });

    it('lets two checks work at once, and a check does not wait for a run', async () => {
      const task = await tasks.create({ title: 'One' });
      await tasks.update(task.id, { aiRun: { agent: 'a', state: 'working', runId: 1 } });
      const a = await history.beginCheck(task.id, { agent: 'claude-code', sessionId: SESSION });
      const b = await history.beginCheck(task.id, { agent: 'claude-code', sessionId: SESSION });
      expect([a.number, b.number]).toEqual([1, 2]);
      expect((await history.checks(task.id)).map((c) => c.state)).toEqual(['working', 'working']);
    });

    it('summarises the checks, newest last', async () => {
      const task = await tasks.create({ title: 'One' });
      const { number } = await history.beginCheck(task.id, {
        agent: 'claude-code',
        sessionId: SESSION,
      });
      await history.report(task.id, number, report());
      await history.beginCheck(task.id, { agent: 'claude-code', sessionId: SESSION });
      expect(await history.checks(task.id)).toEqual([
        expect.objectContaining({
          number: 1,
          state: 'reported',
          verdict: 'partly-outdated',
          version: 1,
        }),
        expect.objectContaining({ number: 2, state: 'working', version: 1 }),
      ]);
    });

    it('announces what happens to a check', async () => {
      const task = await tasks.create({ title: 'One' });
      events.events.length = 0;
      const { number } = await history.beginCheck(task.id, {
        agent: 'claude-code',
        sessionId: SESSION,
      });
      await history.report(task.id, number, report());
      await history.decide(task.id, number, { recommendation: 'r1', decision: 'accepted' });
      await history.endCheck(task.id, number, { sessionId: SESSION });
      expect(events.events).toEqual(
        ['begin', 'report', 'decision', 'end'].map(() => ({
          type: 'check.updated',
          taskId: task.id,
          number,
        })),
      );
    });
  });

  describe('decisions', () => {
    const sent: CheckReportContent = {
      agent: 'claude-code',
      verdict: 'outdated',
      summary: 'S',
      findings: [],
      recommendations: [
        { id: 'r1', findings: [], text: 't', edit: { field: 'title', value: 'New' } },
      ],
    };
    let id: string;
    let number: number;

    beforeEach(async () => {
      id = (await tasks.create({ title: 'One' })).id;
      number = (await history.beginCheck(id, { agent: 'claude-code', sessionId: SESSION })).number;
    });

    it('is accepted only for a reported check (INVARIANT)', async () => {
      expect(
        await code(history.decide(id, number, { recommendation: 'r1', decision: 'accepted' })),
      ).toBe('CHECK_NOT_REPORTED');
      expect((await history.check(id, number)).decisions).toEqual([]);
    });

    it('names an unknown check and an unknown recommendation, and writes nothing', async () => {
      await history.report(id, number, sent);
      expect(
        await code(history.decide(id, 9, { recommendation: 'r1', decision: 'accepted' })),
      ).toBe('CHECK_NOT_FOUND');
      expect(
        await code(history.decide(id, number, { recommendation: 'zz', decision: 'accepted' })),
      ).toBe('RECOMMENDATION_NOT_FOUND');
      expect((await history.check(id, number)).decisions).toEqual([]);
    });

    it('keeps every decision, changes no task, and takes a note', async () => {
      await history.report(id, number, sent);
      const before = await tasks.get(id);
      await history.decide(id, number, { recommendation: 'r1', decision: 'accepted' });
      await history.decide(id, number, { recommendation: 'r1', decision: 'rejected', note: 'no' });
      expect((await history.check(id, number)).decisions.map((d) => [d.decision, d.note])).toEqual([
        ['accepted', undefined],
        ['rejected', 'no'],
      ]);
      expect(await tasks.get(id)).toEqual(before);
    });
  });

  describe('applying a recommendation (fromCheck)', () => {
    const sent: CheckReportContent = {
      agent: 'claude-code',
      verdict: 'outdated',
      summary: 'S',
      findings: [],
      recommendations: [
        { id: 'r1', findings: [], text: 't', edit: { field: 'title', value: 'New' } },
        { id: 'r2', findings: [], text: 'u', edit: { field: 'labels', add: ['z'], remove: [] } },
      ],
    };
    let id: string;
    let number: number;
    const base = { title: 'One', body: '', labels: [] };
    const from = (over: object = {}) => ({
      check: 1,
      recommendations: ['r1'],
      basis: 'report' as const,
      ...over,
    });

    beforeEach(async () => {
      id = (await tasks.create(base)).id;
      number = (await history.beginCheck(id, { agent: 'claude-code', sessionId: SESSION })).number;
      await history.report(id, number, sent);
      await history.decide(id, number, { recommendation: 'r1', decision: 'accepted' });
    });

    it('saves an accepted recommendation of a report that is current, and records where it came from', async () => {
      const saved = await tasks.update(id, {
        title: 'New',
        ifContentHash: contentHash(base),
        fromCheck: from(),
      });
      expect(saved.title).toBe('New');
      const versions = await storage.listVersions(id);
      expect(versions.at(-1)).toMatchObject({ source: 'edit', fromCheck: from() });
    });

    it('answers in the order of the ADR: 404 check, 409 not reported, 404 recommendation, 400, 409 stale', async () => {
      const hash = contentHash(base);
      const failing = (patch: object) => code(tasks.update(id, { title: 'New', ...patch }));

      expect(await failing({ ifContentHash: hash, fromCheck: from({ check: 9 }) })).toBe(
        'CHECK_NOT_FOUND',
      );

      const waiting = (await history.beginCheck(id, { agent: 'claude-code', sessionId: SESSION }))
        .number;
      expect(await failing({ ifContentHash: hash, fromCheck: from({ check: waiting }) })).toBe(
        'CHECK_NOT_REPORTED',
      );
      expect(
        await failing({ ifContentHash: hash, fromCheck: from({ recommendations: ['zz'] }) }),
      ).toBe('RECOMMENDATION_NOT_FOUND');
      // Without ifContentHash a report cannot be applied; and it comes after 1 to 3.
      expect(await failing({ fromCheck: from() })).toBe('INVALID_REQUEST');
      expect(await failing({ fromCheck: from({ check: 9 }) })).toBe('CHECK_NOT_FOUND');
      // A recommendation that was not accepted.
      expect(
        await failing({ ifContentHash: hash, fromCheck: from({ recommendations: ['r2'] }) }),
      ).toBe('STALE_CHECK');
      expect((await tasks.get(id)).title).toBe('One');
    });

    it('checks the hash before the check', async () => {
      expect(
        await code(
          tasks.update(id, {
            title: 'New',
            ifContentHash: '0'.repeat(16),
            fromCheck: from({ check: 9 }),
          }),
        ),
      ).toBe('TASK_CONTENT_CHANGED');
    });

    it('refuses a stale report, even by a client that skips the page (INVARIANT)', async () => {
      await tasks.update(id, { body: 'moved on\n' });
      const now = await tasks.get(id);
      expect(
        await code(
          tasks.update(id, { title: 'New', ifContentHash: contentHash(now), fromCheck: from() }),
        ),
      ).toBe('STALE_CHECK');
      expect((await tasks.get(id)).title).toBe('One');
    });

    it('refuses a recommendation whose latest decision is a rejection', async () => {
      await history.decide(id, number, { recommendation: 'r1', decision: 'rejected' });
      expect(
        await code(
          tasks.update(id, { title: 'New', ifContentHash: contentHash(base), fromCheck: from() }),
        ),
      ).toBe('STALE_CHECK');
    });

    it('takes a manual reconciliation on a changed task: it stops after the three lookups', async () => {
      await tasks.update(id, { body: 'moved on\n' });
      const now = await tasks.get(id);
      const saved = await tasks.update(id, {
        title: 'By hand',
        ifContentHash: contentHash(now),
        fromCheck: from({ basis: 'manual', recommendations: ['r2'] }),
      });
      expect(saved.title).toBe('By hand');
      expect((await storage.listVersions(id)).at(-1)?.fromCheck?.basis).toBe('manual');
      // Manual needs no ifContentHash either.
      expect(
        await code(tasks.update(id, { title: 'Again', fromCheck: from({ basis: 'manual' }) })),
      ).toBe('no error');
    });

    it('records fromCheck nowhere when the content does not change', async () => {
      await tasks.update(id, { title: 'New' });
      const before = await numbers(id);
      const now = await tasks.get(id);
      // The content already is "New", but the pinned version is not the content: so go manual.
      await tasks.update(id, {
        title: 'New',
        ifContentHash: contentHash(now),
        fromCheck: from({ basis: 'manual' }),
      });
      expect(await numbers(id)).toEqual(before);
      expect((await storage.listVersions(id)).some((v) => v.fromCheck?.basis === 'manual')).toBe(
        false,
      );
    });

    it('lets a rejection and a save race: either the save is stale, or the version records an accepted recommendation (INVARIANT)', async () => {
      const hash = contentHash(base);
      const [saved, rejected] = await Promise.all([
        code(tasks.update(id, { title: 'New', ifContentHash: hash, fromCheck: from() })),
        code(history.decide(id, number, { recommendation: 'r1', decision: 'rejected' })),
      ]);
      expect(rejected).toBe('no error');
      const versions = await storage.listVersions(id);
      if (saved === 'no error') {
        // The save came first: the version names an accepted recommendation.
        expect(versions.at(-1)?.fromCheck?.recommendations).toEqual(['r1']);
        expect((await history.check(id, number)).decisions.map((d) => d.decision)).toEqual([
          'accepted',
          'rejected',
        ]);
      } else {
        expect(saved).toBe('STALE_CHECK');
        expect(versions.some((v) => v.fromCheck !== undefined)).toBe(false);
        expect((await tasks.get(id)).title).toBe('One');
      }
    });

    it('leaves no file of history behind a refusal (INVARIANT)', async () => {
      const before = [await numbers(id), (await history.check(id, number)).decisions.length];
      await code(
        tasks.update(id, { title: 'New', ifContentHash: '0'.repeat(16), fromCheck: from() }),
      );
      await code(tasks.update(id, { title: 'New', fromCheck: from() }));
      await code(history.restore(id, 99, { ifContentHash: contentHash(base) }));
      expect([await numbers(id), (await history.check(id, number)).decisions.length]).toEqual(
        before,
      );
    });
  });

  describe('research (ADR-0030 R1–R5)', () => {
    const findings = [
      {
        id: 'f1',
        title: 'F',
        explanation: 'E',
        evidence: [{ kind: 'file' as const, ref: 'a.ts' }],
      },
    ];
    const research = (over: Partial<ResearchReportContent> = {}): ResearchReportContent => ({
      agent: 'claude-code',
      summary: 'The task can be done in two steps.\nDetails follow.',
      findings,
      recommendations: [
        {
          id: 'r1',
          findings: ['f1'],
          text: 'Name the second step.',
          edit: { field: 'labels', add: ['two-steps'], remove: [] },
        },
        { id: 'r2', findings: [], text: 'Split the API part out.', targets: [{ kind: 'task' }] },
      ],
      markdown: '# Research\n\nTwo steps.\n',
      ...over,
    });
    const beginResearch = (id: string, comment?: string) =>
      history.beginCheck(id, {
        agent: 'claude-code',
        sessionId: SESSION,
        kind: 'research',
        ...(comment === undefined ? {} : { comment }),
      });

    it('begins with its kind, its comment and the documents it saw, and no text of them', async () => {
      const task = await tasks.create({ title: 'One' });
      await storage.writeDocument(task.id, 'plan.md', '# Plan\n');
      const { number } = await beginResearch(task.id, 'Focus on the API.');
      const { begin } = await history.check(task.id, number);
      expect(begin).toMatchObject({ kind: 'research', comment: 'Focus on the API.' });
      expect(begin.documents).toEqual([
        { name: 'plan.md', size: 7, updatedAt: expect.any(String) as string },
      ]);
      // An actuality check records none of the three.
      const check = await history.beginCheck(task.id, { agent: 'claude-code', sessionId: SESSION });
      const plain = (await history.check(task.id, check.number)).begin;
      expect(plain).not.toHaveProperty('kind');
      expect(plain).not.toHaveProperty('documents');
    });

    it('runs three researches of one task through, each pinned to the version that is current (INVARIANT)', async () => {
      const task = await tasks.create({ title: 'One', body: 'b\n', labels: [] });
      for (const round of [1, 2, 3]) {
        const now = await tasks.get(task.id);
        const { number, version } = await beginResearch(task.id, `Round ${round}`);
        expect(number).toBe(round);
        expect(version).toBe((await storage.listVersions(task.id)).at(-1)?.number);
        await history.report(task.id, number, research());
        await history.endCheck(task.id, number, { sessionId: SESSION, exitCode: 0 });
        await history.decide(task.id, number, { recommendation: 'r1', decision: 'accepted' });
        await tasks.update(task.id, {
          labels: [...now.labels, `round-${round}`],
          ifContentHash: contentHash(now),
          fromCheck: { check: number, recommendations: ['r1'], basis: 'report' },
        });
      }
      const checks = await history.checks(task.id);
      expect(checks.map((c) => [c.number, c.kind, c.state, c.version])).toEqual([
        [1, 'research', 'reported', 1],
        [2, 'research', 'reported', 2],
        [3, 'research', 'reported', 3],
      ]);
      // Every comment stays with its own begin.
      expect((await history.check(task.id, 1)).begin.comment).toBe('Round 1');
      expect((await history.check(task.id, 3)).begin.comment).toBe('Round 3');
    });

    it('makes the old report stale after the task changes: basis report is 409 STALE_CHECK, nothing written (INVARIANT)', async () => {
      const task = await tasks.create({ title: 'One' });
      const first = await beginResearch(task.id);
      await history.report(task.id, first.number, research());
      await history.decide(task.id, first.number, { recommendation: 'r1', decision: 'accepted' });
      await tasks.update(task.id, { body: 'moved on\n' });

      const second = await beginResearch(task.id);
      expect(second.version).toBe(2);
      const now = await tasks.get(task.id);
      const before = [await numbers(task.id), await tasks.get(task.id)];
      expect(
        await code(
          tasks.update(task.id, {
            labels: ['two-steps'],
            ifContentHash: contentHash(now),
            fromCheck: { check: first.number, recommendations: ['r1'], basis: 'report' },
          }),
        ),
      ).toBe('STALE_CHECK');
      expect([await numbers(task.id), await tasks.get(task.id)]).toEqual(before);
    });

    it('refuses to apply a recommendation rejected after it was accepted', async () => {
      const task = await tasks.create({ title: 'One' });
      const { number } = await beginResearch(task.id);
      await history.report(task.id, number, research());
      await history.decide(task.id, number, { recommendation: 'r1', decision: 'accepted' });
      await history.decide(task.id, number, { recommendation: 'r1', decision: 'rejected' });
      const now = await tasks.get(task.id);
      expect(
        await code(
          tasks.update(task.id, {
            labels: ['two-steps'],
            ifContentHash: contentHash(now),
            fromCheck: { check: number, recommendations: ['r1'], basis: 'report' },
          }),
        ),
      ).toBe('STALE_CHECK');
    });

    it('applies nothing by itself: a decision changes no task, and no version is made (INVARIANT)', async () => {
      const task = await tasks.create({ title: 'One' });
      const { number } = await beginResearch(task.id);
      await history.report(task.id, number, research());
      const before = [await tasks.get(task.id), await numbers(task.id)];
      await history.decide(task.id, number, { recommendation: 'r1', decision: 'accepted' });
      await history.decide(task.id, number, { recommendation: 'r2', decision: 'accepted' });
      await history.endCheck(task.id, number, { sessionId: SESSION });
      expect([await tasks.get(task.id), await numbers(task.id)]).toEqual(before);
    });

    it('changes no task, no run and no document (INVARIANT)', async () => {
      const task = await tasks.create({ title: 'One' });
      await tasks.update(task.id, { aiRun: { agent: 'a', state: 'working', runId: 1 } });
      await storage.writeDocument(task.id, 'report.md', '# Work report\n');
      const before = [await tasks.get(task.id), await storage.listDocuments(task.id)];
      const { number } = await beginResearch(task.id, 'Look around.');
      await history.report(task.id, number, research());
      await history.decide(task.id, number, { recommendation: 'r1', decision: 'rejected' });
      await history.endCheck(task.id, number, { sessionId: SESSION });
      expect([await tasks.get(task.id), await storage.listDocuments(task.id)]).toEqual(before);
      expect(await storage.readDocument(task.id, 'report.md')).toBe('# Work report\n');
    });

    it('validates the report by the kind of the check: 422, and the check stays working', async () => {
      const task = await tasks.create({ title: 'One' });
      const { number } = await beginResearch(task.id);
      const { markdown: _markdown, ...withoutMarkdown } = research();
      const refusals = [
        withoutMarkdown,
        { ...research(), verdict: 'current' },
        research({ markdown: 'x'.repeat(200_001) }),
      ];
      for (const sent of refusals) {
        const error = await history
          .report(task.id, number, sent as ResearchReportContent)
          .catch((e: unknown) => e as BoardError);
        expect(error).toMatchObject({ code: 'INVALID_CHECK_REPORT' });
      }
      const check = await history.beginCheck(task.id, { agent: 'claude-code', sessionId: SESSION });
      expect(
        await code(
          history.report(task.id, check.number, {
            ...research(),
            verdict: 'current',
          } as unknown as CheckReportContent),
        ),
      ).toBe('INVALID_CHECK_REPORT');
      expect((await history.check(task.id, number)).state).toBe('working');
      expect(await storage.readCheckMarkdown(task.id, number)).toBeNull();
    });

    it('serves the markdown of a published report only (ADR-0030 R3)', async () => {
      const task = await tasks.create({ title: 'One' });
      const { number } = await beginResearch(task.id);
      expect(await code(history.reportMarkdown(task.id, number))).toBe('CHECK_NOT_REPORTED');
      await history.report(task.id, number, research());
      expect(await history.reportMarkdown(task.id, number)).toBe('# Research\n\nTwo steps.\n');
      expect(await code(history.reportMarkdown(task.id, 9))).toBe('CHECK_NOT_FOUND');

      const check = await history.beginCheck(task.id, { agent: 'claude-code', sessionId: SESSION });
      await history.report(task.id, check.number, {
        agent: 'a',
        verdict: 'current',
        summary: 's',
        findings: [],
        recommendations: [],
      });
      expect(await history.reportMarkdown(task.id, check.number)).toBeNull();
    });

    it('summarises its kind, a short comment and the count of decisions', async () => {
      const task = await tasks.create({ title: 'One' });
      const { number } = await beginResearch(task.id, `Look at the API.\n${'x'.repeat(300)}`);
      await history.beginCheck(task.id, { agent: 'claude-code', sessionId: SESSION });
      await history.report(task.id, number, research());
      await history.decide(task.id, number, { recommendation: 'r1', decision: 'accepted' });
      await history.decide(task.id, number, { recommendation: 'r1', decision: 'rejected' });
      const [first, second] = await history.checks(task.id);
      expect(first).toMatchObject({
        kind: 'research',
        comment: 'Look at the API.…',
        decisions: { accepted: 0, rejected: 1, undecided: 1 },
      });
      expect(first).not.toHaveProperty('verdict');
      expect(second).not.toHaveProperty('kind');
      expect(second).not.toHaveProperty('comment');
      expect(second).not.toHaveProperty('decisions');
    });

    it('lets two decisions and an apply race under the lock: exactly one outcome (INVARIANT)', async () => {
      const task = await tasks.create({ title: 'One', labels: [] });
      const { number } = await beginResearch(task.id);
      await history.report(task.id, number, research());
      await history.decide(task.id, number, { recommendation: 'r1', decision: 'accepted' });
      const hash = contentHash(await tasks.get(task.id));
      const [rejected, accepted, saved] = await Promise.all([
        code(history.decide(task.id, number, { recommendation: 'r1', decision: 'rejected' })),
        code(history.decide(task.id, number, { recommendation: 'r1', decision: 'accepted' })),
        code(
          tasks.update(task.id, {
            labels: ['two-steps'],
            ifContentHash: hash,
            fromCheck: { check: number, recommendations: ['r1'], basis: 'report' },
          }),
        ),
      ]);
      expect([rejected, accepted]).toEqual(['no error', 'no error']);
      expect((await history.check(task.id, number)).decisions).toHaveLength(3);
      const versions = await storage.listVersions(task.id);
      if (saved === 'no error') {
        // The save ran while r1 was accepted: one version records it, and only one.
        expect(versions.filter((v) => v.fromCheck !== undefined)).toHaveLength(1);
        expect((await tasks.get(task.id)).labels).toEqual(['two-steps']);
      } else {
        // It ran after the rejection: nothing of it was written.
        expect(saved).toBe('STALE_CHECK');
        expect(versions.some((v) => v.fromCheck !== undefined)).toBe(false);
        expect((await tasks.get(task.id)).labels).toEqual([]);
      }
    });
  });

  describe('deleting a task', () => {
    it('takes its history with it and gives the number to no one', async () => {
      const task = await tasks.create({ title: 'One' });
      await history.beginCheck(task.id, { agent: 'claude-code', sessionId: SESSION });
      await tasks.remove(task.id);
      expect(await code(history.versions(task.id))).toBe('TASK_NOT_FOUND');
      expect((await tasks.create({ title: 'Two' })).id).not.toBe(task.id);
    });
  });
});
