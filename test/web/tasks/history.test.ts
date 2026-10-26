import {
  contentHash,
  type DiffLine,
  type RecommendationAxes,
  type VersionList,
} from '../../../src/contract/v1/index';
import {
  axisLabels,
  checkId,
  countsText,
  isSuperseded,
  kindLabel,
  launchNotice,
  recommendationState,
  currentVersion,
  decisionOf,
  describeRepo,
  draftChanges,
  hasChanges,
  normalizeSelection,
  repoChanged,
  staleness,
  stalenessText,
  versionOptions,
  versionSummaryText,
} from '../../../src/web/features/tasks/model/history';
import { foldContext } from '../../../src/web/features/tasks/ui/ContentDiffView';
import { aCheck, aResearch, aTask } from '../support/fixtures';

const task = aTask({ id: 'T1', title: 'A', body: 'text\n', labels: ['x'] });
const hashOf = (t: { title: string; body: string; labels: string[] }): string =>
  contentHash({ title: t.title, body: t.body, labels: t.labels });

const summary = (number: number, hash: string): VersionList['versions'][number] => ({
  taskId: 'T1',
  number,
  createdAt: '2026-10-17T10:00:00.000Z',
  source: 'edit',
  changed: [],
  hash,
});

const listAt = (...hashes: string[]): VersionList => ({
  current: { hash: hashOf(task), version: null },
  versions: hashes.map((hash, index) => summary(index + 1, hash)),
});

describe('the version of the task now', () => {
  it('is the latest version when its hash is the content, else none (outside history)', () => {
    expect(currentVersion(task, listAt('0'.repeat(16), hashOf(task)))).toBe(2);
    expect(currentVersion(task, listAt(hashOf(task), '0'.repeat(16)))).toBeNull();
    expect(currentVersion(task, undefined)).toBeNull();
    expect(currentVersion(task, listAt())).toBeNull();
  });
});

describe('versionOptions', () => {
  it('puts the current first and calls the others historical, newest first', () => {
    const options = versionOptions(task, listAt('1'.repeat(16), '2'.repeat(16), hashOf(task)));
    expect(options).toEqual([
      { value: 'current', label: 'v3 · Current' },
      { value: '2', label: 'v2 · historical' },
      { value: '1', label: 'v1 · historical' },
    ]);
  });

  it('makes the current entry "changed outside history" when no version is it', () => {
    const options = versionOptions(task, listAt('1'.repeat(16), '2'.repeat(16)));
    expect(options.map((o) => o.label)).toEqual([
      'Current (changed outside history)',
      'v2 · historical',
      'v1 · historical',
    ]);
  });

  it('is only "Current" for a task with no versions or no list yet', () => {
    expect(versionOptions(task, listAt())).toEqual([{ value: 'current', label: 'Current' }]);
    expect(versionOptions(task, undefined)).toEqual([{ value: 'current', label: 'Current' }]);
  });
});

describe('normalizeSelection', () => {
  it('takes the version the task is at for the current one', () => {
    const list = listAt('1'.repeat(16), hashOf(task));
    expect(normalizeSelection(2, task, list)).toBe('current');
    expect(normalizeSelection(1, task, list)).toBe(1);
    expect(normalizeSelection('current', task, list)).toBe('current');
  });
});

describe('versionSummaryText', () => {
  it('says where a version came from and what it changed', () => {
    expect(versionSummaryText({ ...summary(2, 'a'.repeat(16)), changed: ['title', 'body'] })).toBe(
      'edited · changed: title, body',
    );
    expect(
      versionSummaryText({ ...summary(3, 'a'.repeat(16)), source: 'restore', restoredFrom: 1 }),
    ).toBe('restored · from v1');
    expect(
      versionSummaryText({
        ...summary(4, 'a'.repeat(16)),
        fromCheck: { check: 2, recommendations: ['r1'], basis: 'manual' },
      }),
    ).toBe('edited · from check C2 (manual)');
    expect(versionSummaryText({ ...summary(1, 'a'.repeat(16)), source: 'baseline' })).toBe(
      'first seen',
    );
  });
});

describe('draftChanges: only what the person changed is sent', () => {
  const draft = { title: 'A', status: 'todo', labels: ['x'], body: 'text\n' };
  const original = aTask({ title: 'A', status: 'todo', labels: ['x'], body: 'text\n' });

  it('is nothing for a draft that equals the task', () => {
    const changes = draftChanges(original, draft);
    expect(changes).toEqual({ content: {} });
    expect(hasChanges(changes)).toBe(false);
  });

  it('names a field only when it differs, labels as ordered arrays', () => {
    expect(draftChanges(original, { ...draft, title: 'B' })).toEqual({ content: { title: 'B' } });
    expect(draftChanges(original, { ...draft, body: 'other' })).toEqual({
      content: { body: 'other' },
    });
    expect(draftChanges(original, { ...draft, labels: ['x', 'y'] })).toEqual({
      content: { labels: ['x', 'y'] },
    });
    expect(
      draftChanges({ ...original, labels: ['a', 'b'] }, { ...draft, labels: ['b', 'a'] }),
    ).toEqual({ content: { labels: ['b', 'a'] } });
  });

  it('sends the status and the branch only when changed; no branch clears it', () => {
    expect(draftChanges(original, { ...draft, status: 'done' })).toEqual({
      content: {},
      status: 'done',
    });
    expect(draftChanges(original, { ...draft, branch: 'feat/x' })).toEqual({
      content: {},
      branch: 'feat/x',
    });
    expect(draftChanges({ ...original, branch: 'feat/x' }, draft)).toEqual({
      content: {},
      branch: null,
    });
    expect(draftChanges({ ...original, branch: 'feat/x' }, { ...draft, branch: 'feat/x' })).toEqual(
      {
        content: {},
      },
    );
  });
});

describe('staleness', () => {
  it('compares the content now with that of the version the check read (INVARIANT)', () => {
    const list = listAt('1'.repeat(16), hashOf(task));
    expect(staleness(task, list, { version: 2 })).toEqual({
      version: 2,
      now: 2,
      known: true,
      stale: false,
    });
    const stale = staleness(task, list, { version: 1 });
    expect(stale).toMatchObject({ stale: true, now: 2 });
    expect(stalenessText(stale)).toBe('This report is for v1; the task is now v2.');
  });

  it('says changed outside the history when no version is the task now', () => {
    const stale = staleness(task, listAt('1'.repeat(16)), { version: 1 });
    expect(stalenessText(stale)).toBe(
      'This report is for v1; the task was changed outside the history since.',
    );
  });

  it('claims nothing while the history is not read', () => {
    expect(staleness(task, undefined, { version: 1 })).toMatchObject({
      known: false,
      stale: false,
    });
    expect(staleness(task, listAt(), { version: 1 })).toMatchObject({ known: false, stale: false });
    expect(stalenessText(staleness(task, undefined, { version: 1 }))).toBeUndefined();
  });
});

describe('the repository and the decisions of a check', () => {
  it('describes the repository, or says there is none', () => {
    expect(describeRepo(null)).toBe('no git repository');
    expect(describeRepo({ branch: 'main', head: '9f1c1a2b3c4d', clean: true })).toBe(
      'main @ 9f1c1a2, clean',
    );
    expect(describeRepo({ branch: null, head: null, clean: false })).toBe(
      'detached @ no commits, uncommitted changes',
    );
  });

  it('sees that the repository changed between the start and the report', () => {
    const check = aCheck();
    expect(repoChanged(check)).toBe(false);
    if (check.report) check.report.repo = { branch: 'main', head: 'ffffffffff', clean: true };
    expect(repoChanged(check)).toBe(true);
    delete check.report;
    expect(repoChanged(check)).toBe(false);
  });

  it('takes the latest decision per recommendation, and names the version it was applied in', () => {
    const check = aCheck({
      decisions: [1, 2, 3].map((number) => ({
        taskId: 'T1',
        check: 1,
        number,
        recommendation: 'r1',
        decision: number === 2 ? ('rejected' as const) : ('accepted' as const),
        createdAt: '2026-10-17T10:00:00.000Z',
      })),
    });
    expect(decisionOf(check, 'r1')).toBe('accepted');
    expect(decisionOf(check, 'r2')).toBe('undecided');

    const list: VersionList = {
      ...listAt('1'.repeat(16)),
      versions: [
        summary(1, '1'.repeat(16)),
        {
          ...summary(2, '2'.repeat(16)),
          fromCheck: { check: 1, recommendations: ['r1'], basis: 'report' },
        },
        {
          ...summary(3, '3'.repeat(16)),
          fromCheck: { check: 2, recommendations: ['r1'], basis: 'report' },
        },
      ],
    };
    const r1 = check.report!.recommendations[0]!;
    expect(recommendationState(task, list, [], check, r1).application).toEqual({
      state: 'applied',
      versions: [2],
    });
    expect(recommendationState(task, undefined, [], check, r1).application).toEqual({
      state: 'not-applied',
    });
    expect(checkId('T12', 3)).toBe('T12-C3');
  });
});

describe('foldContext', () => {
  const line = (kind: DiffLine['kind'], text: string): DiffLine => ({ kind, text });

  it('keeps a few lines around a change and folds the long runs between', () => {
    const same = Array.from({ length: 20 }, (_, i) => line('same', `s${i}`));
    const rows = foldContext([...same, line('add', 'new'), ...same.map((l) => ({ ...l }))]);
    const kinds = rows.map((row) => (row.kind === 'fold' ? `fold ${row.hidden}` : row.line.kind));
    expect(kinds).toEqual([
      'fold 17',
      'same',
      'same',
      'same',
      'add',
      'same',
      'same',
      'same',
      'fold 17',
    ]);
  });

  it('folds nothing in a short text, or when everything changed', () => {
    expect(foldContext([line('same', 'a'), line('add', 'b')]).every((r) => r.kind === 'line')).toBe(
      true,
    );
    expect(foldContext([])).toEqual([]);
  });
});

describe('the three axes of a recommendation, as the page says them (ADR-0030 R5)', () => {
  it.each<[RecommendationAxes, ReturnType<typeof axisLabels>]>([
    [
      { decision: 'undecided', application: { state: 'not-applied' }, currency: 'current' },
      { decision: 'Undecided', application: 'Not applied', currency: 'Current' },
    ],
    [
      { decision: 'accepted', application: { state: 'not-applied' }, currency: 'current' },
      { decision: 'Accepted', application: 'Not applied', currency: 'Current' },
    ],
    [
      {
        decision: 'rejected',
        application: { state: 'applied', versions: [2, 4] },
        currency: 'stale',
      },
      { decision: 'Rejected', application: 'Applied in v2, v4', currency: 'Stale' },
    ],
    [
      { decision: 'accepted', application: { state: 'not-applicable' }, currency: 'superseded' },
      { decision: 'Accepted', application: 'Not applicable here', currency: 'Superseded' },
    ],
  ])('%j → %j', (axes, labels) => {
    expect(axisLabels(axes)).toEqual(labels);
  });

  it('does not take "applied" from "accepted": only a version that names it (INVARIANT)', () => {
    const accepted = aCheck({
      decisions: [
        {
          taskId: 'T1',
          check: 1,
          number: 1,
          recommendation: 'r1',
          decision: 'accepted',
          createdAt: '2026-10-17T10:06:00.000Z',
        },
      ],
    });
    const r1 = accepted.report!.recommendations[0]!;
    const state = recommendationState(task, listAt(hashOf(task)), [], accepted, r1);
    expect(state.decision).toBe('accepted');
    expect(axisLabels(state).application).toBe('Not applied');
  });

  it('says a recommendation aimed at a document or a file is not applicable here (D4)', () => {
    const research = aResearch();
    const [r1, r2, r3] = research.report!.recommendations;
    const state = (r: typeof r1) =>
      axisLabels(recommendationState(task, undefined, [], research, r!)).application;
    expect(state(r1)).toBe('Not applied');
    expect(state(r2)).toBe('Not applicable here');
    expect(state(r3)).toBe('Not applicable here');
  });
});

describe('superseded and the counts of the list', () => {
  const summaries = (...states: ('working' | 'reported' | 'failed')[]) =>
    states.map((state, index) => ({ number: index + 1, state }));

  it('is superseded only by a later check or research that reported', () => {
    expect(isSuperseded(summaries('reported', 'reported'), 1)).toBe(true);
    expect(isSuperseded(summaries('reported', 'working'), 1)).toBe(false);
    expect(isSuperseded(summaries('reported', 'failed'), 1)).toBe(false);
    expect(isSuperseded(summaries('reported', 'reported'), 2)).toBe(false);
  });

  it('marks the recommendations of a superseded report, and stale wins over it', () => {
    const research = aResearch();
    const r1 = research.report!.recommendations[0]!;
    const later = summaries('reported', 'reported');
    expect(recommendationState(task, undefined, later, research, r1).currency).toBe('superseded');
    // v1 of the report against a task that is not v1 any more.
    const moved = listAt(hashOf(task));
    moved.versions = [summary(1, '1'.repeat(16)), summary(2, hashOf(task))];
    expect(recommendationState(task, moved, later, research, r1).currency).toBe('stale');
  });

  it('counts the decisions, and names the kind', () => {
    expect(countsText({ accepted: 1, rejected: 0, undecided: 2 })).toBe(
      '1 accepted · 0 rejected · 2 undecided',
    );
    expect(countsText(undefined)).toBeUndefined();
    expect(kindLabel('research')).toBe('Research');
    expect(kindLabel(undefined)).toBe('Actuality check');
  });
});

describe('the notice of the launch dialog (D11)', () => {
  const at = (over: object) => ({
    taskId: 'T1',
    number: 1,
    state: 'reported' as const,
    version: 1,
    createdAt: '2026-10-17T10:00:00.000Z',
    agent: 'claude-code',
    ...over,
  });

  it('names a research still working and recommendations still undecided', () => {
    expect(launchNotice(undefined)).toBeUndefined();
    expect(launchNotice([])).toBeUndefined();
    expect(
      launchNotice([
        at({ kind: 'research', decisions: { accepted: 1, rejected: 1, undecided: 0 } }),
      ]),
    ).toBeUndefined();
    expect(launchNotice([at({ kind: 'research', state: 'working', number: 2 })])).toBe(
      'T1-C2 is still researching this task. Starting now does not wait for it.',
    );
    expect(
      launchNotice([
        at({ kind: 'research', decisions: { accepted: 0, rejected: 0, undecided: 2 } }),
      ]),
    ).toBe('T1-C1 has 2 undecided recommendations. Starting now does not decide them.');
  });

  it('says nothing of an actuality check: D11 is about research', () => {
    expect(
      launchNotice([at({ decisions: { accepted: 0, rejected: 0, undecided: 2 } })]),
    ).toBeUndefined();
  });
});
