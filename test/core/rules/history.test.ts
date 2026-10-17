import type { CheckReportContent, Decision, TaskContent } from '../../../src/core/model/index.js';
import {
  applyRecommendations,
  assembleCheck,
  changedFields,
  checkState,
  contentHash,
  diffContent,
  diffLines,
  isReportStale,
  latestDecisions,
  occurrences,
  reportProblems,
  sameContent,
} from '../../../src/core/rules/history.js';

const content = (over: Partial<TaskContent> = {}): TaskContent => ({
  title: 'Add versions',
  body: '## Goal\n\nKeep every change.\n',
  labels: ['ui', 'api'],
  ...over,
});

describe('contentHash', () => {
  it('is deterministic and 16 hex digits (INVARIANT: the page and the server agree)', () => {
    expect(contentHash(content())).toBe(contentHash(content()));
    expect(contentHash(content())).toMatch(/^[0-9a-f]{16}$/);
  });

  it('pins the algorithm: FNV-1a over the canonical JSON of [title, body, labels]', () => {
    // The page and the server run the same function; a change of it is a change of the contract.
    expect(contentHash({ title: 'a', body: '', labels: [] })).toBe('fe12a95a2f2a23de');
  });

  it('changes with one character of the title or of the body', () => {
    const base = contentHash(content());
    expect(contentHash(content({ title: 'Add version' }))).not.toBe(base);
    expect(contentHash(content({ body: '## Goal\n\nKeep every change' }))).not.toBe(base);
  });

  it('changes with the order of the labels', () => {
    expect(contentHash(content({ labels: ['api', 'ui'] }))).not.toBe(contentHash(content()));
  });

  it('cannot be fooled by moving text between the fields', () => {
    expect(contentHash({ title: 'ab', body: 'c', labels: [] })).not.toBe(
      contentHash({ title: 'a', body: 'bc', labels: [] }),
    );
  });
});

describe('what counts as a change', () => {
  it('is none for equal content, and names the fields that differ otherwise', () => {
    expect(sameContent(content(), content())).toBe(true);
    expect(changedFields(content(), content())).toEqual([]);
    expect(changedFields(content(), content({ title: 'x', labels: [] }))).toEqual([
      'title',
      'labels',
    ]);
  });

  it('compares labels as ordered arrays', () => {
    expect(changedFields(content(), content({ labels: ['api', 'ui'] }))).toEqual(['labels']);
  });

  it('sees a trailing space', () => {
    expect(changedFields(content(), content({ body: `${content().body} ` }))).toEqual(['body']);
  });
});

describe('diffLines', () => {
  const show = (before: string, after: string): string[] =>
    diffLines(before, after).map(
      ({ kind, text }) => `${kind === 'add' ? '+' : kind === 'remove' ? '-' : ' '}${text}`,
    );

  it('shows equal texts as unchanged lines', () => {
    expect(show('a\nb', 'a\nb')).toEqual([' a', ' b']);
  });

  it('shows an added, a removed and a replaced line', () => {
    expect(show('a\nb', 'a\nb\nc')).toEqual([' a', ' b', '+c']);
    expect(show('a\nb\nc', 'a\nc')).toEqual([' a', '-b', ' c']);
    expect(show('a\nb\nc', 'a\nx\nc')).toEqual([' a', '-b', '+x', ' c']);
  });

  it('handles an empty side', () => {
    expect(show('', 'a')).toEqual(['+a']);
    expect(show('a', '')).toEqual(['-a']);
    expect(show('', '')).toEqual([]);
  });

  it('puts the lines back together: the diff holds both texts', () => {
    const before = 'one\ntwo\nthree\nfour\nfive';
    const after = 'one\n2\nthree\nfive\nsix';
    const lines = diffLines(before, after);
    expect(
      lines
        .filter((l) => l.kind !== 'add')
        .map((l) => l.text)
        .join('\n'),
    ).toBe(before);
    expect(
      lines
        .filter((l) => l.kind !== 'remove')
        .map((l) => l.text)
        .join('\n'),
    ).toBe(after);
  });

  it('falls back to a whole replacement for a very large middle, still holding both texts', () => {
    const before = Array.from({ length: 2500 }, (_, i) => `a${i}`).join('\n');
    const after = Array.from({ length: 2500 }, (_, i) => `b${i}`).join('\n');
    const lines = diffLines(before, after);
    expect(lines.filter((l) => l.kind === 'remove')).toHaveLength(2500);
    expect(lines.filter((l) => l.kind === 'add')).toHaveLength(2500);
  });
});

describe('diffContent', () => {
  it('has a part for each field that changed and null for the others', () => {
    const diff = diffContent(content(), content({ title: 'New', labels: ['api', 'new'] }));
    expect(diff.changed).toEqual(['title', 'labels']);
    expect(diff.title).toEqual({ before: 'Add versions', after: 'New' });
    expect(diff.body).toBeNull();
    expect(diff.labels).toEqual({ added: ['new'], removed: ['ui'], reordered: false });
  });

  it('says when labels were only reordered', () => {
    const diff = diffContent(content(), content({ labels: ['api', 'ui'] }));
    expect(diff.labels).toEqual({ added: [], removed: [], reordered: true });
  });
});

describe('applyRecommendations', () => {
  it('applies a title, a labels and a body edit in order', () => {
    const result = applyRecommendations(content(), [
      { id: 'r1', edit: { field: 'title', value: 'Add history' } },
      { id: 'r2', edit: { field: 'labels', add: ['new'], remove: ['ui'] } },
      { id: 'r3', edit: { field: 'body', find: 'Keep every change.', replace: 'Keep it all.' } },
    ]);
    expect(result.content).toEqual({
      title: 'Add history',
      body: '## Goal\n\nKeep it all.\n',
      labels: ['api', 'new'],
    });
    expect(result.applied).toEqual(['r1', 'r2', 'r3']);
    expect(result.notApplied).toEqual([]);
  });

  it('leaves out a find that is absent or that occurs twice, and names it (INVARIANT)', () => {
    const doubled = content({ body: 'x y x' });
    const result = applyRecommendations(doubled, [
      { id: 'missing', edit: { field: 'body', find: 'zzz', replace: '-' } },
      { id: 'twice', edit: { field: 'body', find: 'x', replace: '-' } },
    ]);
    expect(result.content).toEqual(doubled);
    expect(result.notApplied).toEqual([
      { id: 'missing', reason: 'not-found' },
      { id: 'twice', reason: 'ambiguous' },
    ]);
  });

  it('needs a find to occur once after the earlier edits, not only before them', () => {
    const result = applyRecommendations(content({ body: 'a b' }), [
      { id: 'one', edit: { field: 'body', find: 'a', replace: 'b' } },
      { id: 'two', edit: { field: 'body', find: 'b', replace: 'c' } },
    ]);
    expect(result.applied).toEqual(['one']);
    expect(result.notApplied).toEqual([{ id: 'two', reason: 'ambiguous' }]);
    expect(result.content.body).toBe('b b');
  });

  it('never applies advice, a recommendation without an edit', () => {
    const result = applyRecommendations(content(), [{ id: 'advice' }]);
    expect(result.content).toEqual(content());
    expect(result.notApplied).toEqual([{ id: 'advice', reason: 'advice' }]);
  });

  it('refuses a blank title', () => {
    const result = applyRecommendations(content(), [
      { id: 'blank', edit: { field: 'title', value: '  ' } },
    ]);
    expect(result.content.title).toBe('Add versions');
    expect(result.notApplied).toEqual([{ id: 'blank', reason: 'blank-title' }]);
  });

  it('does not touch the content it was given', () => {
    const original = content();
    applyRecommendations(original, [
      { id: 'r', edit: { field: 'labels', add: ['x'], remove: [] } },
    ]);
    expect(original).toEqual(content());
  });

  it('adds a label once', () => {
    const result = applyRecommendations(content(), [
      { id: 'r', edit: { field: 'labels', add: ['ui', 'ui', 'z'], remove: [] } },
    ]);
    expect(result.content.labels).toEqual(['ui', 'api', 'z']);
  });
});

describe('occurrences', () => {
  it('counts without overlap, and an empty find is none', () => {
    expect(occurrences('aaaa', 'aa')).toBe(2);
    expect(occurrences('abc', '')).toBe(0);
    expect(occurrences('abc', 'd')).toBe(0);
  });
});

describe('the state of a check', () => {
  it('follows from the files: begin only is working, a report is reported, an end alone failed', () => {
    expect(checkState({})).toBe('working');
    expect(checkState({ report: {} })).toBe('reported');
    expect(checkState({ report: {}, end: {} })).toBe('reported');
    expect(checkState({ end: {} })).toBe('failed');
  });

  it('assembles a check with its decisions in order', () => {
    const decision = (number: number): Decision => ({
      taskId: 'T1',
      check: 1,
      number,
      recommendation: 'r1',
      decision: 'accepted',
      createdAt: '2026-10-17T10:00:00.000Z',
    });
    const check = assembleCheck({
      begin: {
        taskId: 'T1',
        number: 1,
        version: 1,
        createdAt: '2026-10-17T10:00:00.000Z',
        agent: 'claude-code',
        sessionId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
        repo: null,
      },
      decisions: [decision(2), decision(1)],
    });
    expect(check.state).toBe('working');
    expect(check.decisions.map((d) => d.number)).toEqual([1, 2]);
  });
});

describe('latestDecisions', () => {
  it('keeps the latest decision per recommendation', () => {
    const make = (number: number, recommendation: string, decision: 'accepted' | 'rejected') =>
      ({
        taskId: 'T1',
        check: 1,
        number,
        recommendation,
        decision,
        createdAt: '2026-10-17T10:00:00.000Z',
      }) satisfies Decision;
    const latest = latestDecisions([
      make(3, 'a', 'rejected'),
      make(1, 'a', 'accepted'),
      make(2, 'b', 'accepted'),
    ]);
    expect(latest.get('a')?.decision).toBe('rejected');
    expect(latest.get('b')?.decision).toBe('accepted');
  });
});

describe('isReportStale', () => {
  it('is a comparison of the content now with that of the version checked', () => {
    expect(isReportStale(content(), content())).toBe(false);
    expect(isReportStale(content({ title: 'x' }), content())).toBe(true);
  });
});

describe('reportProblems', () => {
  const report = (over: Partial<CheckReportContent> = {}): CheckReportContent => ({
    agent: 'claude-code',
    verdict: 'partly-outdated',
    summary: 'Mostly fine.',
    findings: [
      {
        id: 'f1',
        title: 'A finding',
        explanation: 'Why.',
        evidence: [{ kind: 'file', ref: 'src/a.ts' }],
      },
    ],
    recommendations: [{ id: 'r1', findings: ['f1'], text: 'Do it.' }],
    ...over,
  });

  it('finds nothing wrong with a sound report', () => {
    expect(reportProblems(report(), content())).toEqual([]);
  });

  it('requires a body find to occur exactly once in the checked version', () => {
    const edit = (find: string): CheckReportContent['recommendations'] => [
      { id: 'r1', findings: [], text: 't', edit: { field: 'body', find, replace: 'x' } },
    ];
    expect(
      reportProblems(report({ recommendations: edit('Keep every change.') }), content()),
    ).toEqual([]);
    expect(reportProblems(report({ recommendations: edit('nowhere') }), content())).toHaveLength(1);
    expect(reportProblems(report({ recommendations: edit('e') }), content())).toHaveLength(1);
  });

  it('refuses a blank title edit, repeated ids and an unknown finding', () => {
    const problems = reportProblems(
      report({
        findings: [
          { id: 'f1', title: 't', explanation: 'e', evidence: [] },
          { id: 'f1', title: 't', explanation: 'e', evidence: [] },
        ],
        recommendations: [
          { id: 'r1', findings: ['zz'], text: 't', edit: { field: 'title', value: ' ' } },
          { id: 'r1', findings: [], text: 't' },
        ],
      }),
      content(),
    );
    expect(problems).toHaveLength(4);
  });

  it('checks the form of evidence refs, and looks nothing up', () => {
    const evidence = (kind: 'file' | 'commit' | 'task', ref: string) =>
      report({
        findings: [{ id: 'f1', title: 't', explanation: 'e', evidence: [{ kind, ref }] }],
      });
    expect(reportProblems(evidence('commit', '9f1c1a2b'), content())).toEqual([]);
    expect(reportProblems(evidence('commit', 'HEAD'), content())).toHaveLength(1);
    expect(reportProblems(evidence('task', 'T99'), content())).toEqual([]);
    expect(reportProblems(evidence('task', 'not-a-task'), content())).toHaveLength(1);
    expect(reportProblems(evidence('file', '/etc/passwd'), content())).toHaveLength(1);
    expect(reportProblems(evidence('file', '../outside'), content())).toHaveLength(1);
    expect(reportProblems(evidence('file', 'src/missing.ts'), content())).toEqual([]);
  });
});
