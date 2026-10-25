import type { CheckReportContent, Decision, TaskContent } from '../../../src/core/model/index.js';
import {
  applyBlockers,
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
  recommendationAxes,
  reportKindProblems,
  reportProblems,
  sameContent,
  summarizeComment,
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

describe('the derived axes of a recommendation (ADR-0030 R5)', () => {
  const decision = (number: number, recommendation: string, value: 'accepted' | 'rejected') =>
    ({
      taskId: 'T1',
      check: 1,
      number,
      recommendation,
      decision: value,
      createdAt: '2026-10-17T10:00:00.000Z',
    }) satisfies Decision;
  const edit = { field: 'title' as const, value: 'New' };
  const axes = (
    over: {
      decisions?: Decision[];
      recommendation?: Parameters<typeof recommendationAxes>[0]['recommendation'];
      versions?: Parameters<typeof recommendationAxes>[0]['versions'];
      stale?: boolean;
      checks?: Parameters<typeof recommendationAxes>[0]['checks'];
    } = {},
  ) =>
    recommendationAxes({
      check: 1,
      decisions: over.decisions ?? [],
      recommendation: over.recommendation ?? { id: 'r1', edit },
      versions: over.versions ?? [],
      stale: over.stale ?? false,
      checks: over.checks ?? [{ number: 1, state: 'reported' }],
    });
  const appliedV2 = [
    { number: 2, fromCheck: { check: 1, recommendations: ['r1'], basis: 'report' as const } },
  ];

  it.each([
    // decision, applied in, stale, later check → decision, application, currency
    [[], [], false, [], 'undecided', { state: 'not-applied' }, 'current'],
    [['accepted'], [], false, [], 'accepted', { state: 'not-applied' }, 'current'],
    [
      ['accepted'],
      appliedV2,
      false,
      [],
      'accepted',
      { state: 'applied', versions: [2] },
      'current',
    ],
    [
      ['accepted', 'rejected'],
      appliedV2,
      true,
      [],
      'rejected',
      { state: 'applied', versions: [2] },
      'stale',
    ],
    [['rejected'], [], false, ['reported'], 'rejected', { state: 'not-applied' }, 'superseded'],
    [['accepted'], [], true, ['reported'], 'accepted', { state: 'not-applied' }, 'stale'],
    [[], [], false, ['working'], 'undecided', { state: 'not-applied' }, 'current'],
    [[], [], false, ['failed'], 'undecided', { state: 'not-applied' }, 'current'],
  ] as const)(
    'decisions %j, versions %j, stale %s, later check %j → %s, %j, %s',
    (decisions, versions, stale, later, expectedDecision, application, currency) => {
      expect(
        axes({
          decisions: decisions.map((value, index) => decision(index + 1, 'r1', value)),
          versions: [...versions],
          stale,
          checks: [
            { number: 1, state: 'reported' },
            ...later.map((state, index) => ({ number: index + 2, state })),
          ],
        }),
      ).toEqual({ decision: expectedDecision, application, currency });
    },
  );

  it('never makes "applied" out of "accepted": only a version that names it is an application (INVARIANT)', () => {
    const accepted = axes({ decisions: [decision(1, 'r1', 'accepted')] });
    expect(accepted.application).toEqual({ state: 'not-applied' });
    // A version from another check, or naming another recommendation, is not this one's.
    const other = axes({
      decisions: [decision(1, 'r1', 'accepted')],
      versions: [
        { number: 2, fromCheck: { check: 2, recommendations: ['r1'], basis: 'report' } },
        { number: 3, fromCheck: { check: 1, recommendations: ['r2'], basis: 'report' } },
        { number: 4 },
      ],
    });
    expect(other.application).toEqual({ state: 'not-applied' });
  });

  it('is superseded only by a later check that is reported, never by an earlier one (INVARIANT)', () => {
    const earlier = recommendationAxes({
      check: 2,
      decisions: [],
      recommendation: { id: 'r1', edit },
      versions: [],
      stale: false,
      checks: [
        { number: 1, state: 'reported' },
        { number: 2, state: 'reported' },
        { number: 3, state: 'working' },
      ],
    });
    expect(earlier.currency).toBe('current');
  });

  it('says "not applicable" of advice and of a recommendation aimed elsewhere than the task', () => {
    expect(axes({ recommendation: { id: 'r1' } }).application).toEqual({
      state: 'not-applicable',
    });
    expect(
      axes({
        recommendation: { id: 'r1', edit, targets: [{ kind: 'file', ref: 'src/a.ts' }] },
      }).application,
    ).toEqual({ state: 'not-applicable' });
    expect(
      axes({
        recommendation: {
          id: 'r1',
          edit,
          targets: [{ kind: 'document', name: 'plan.md' }, { kind: 'task' }],
        },
      }).application,
    ).toEqual({ state: 'not-applied' });
  });

  it('keeps an application by hand of advice: the version is the fact', () => {
    expect(
      axes({
        recommendation: { id: 'r1' },
        versions: [
          { number: 5, fromCheck: { check: 1, recommendations: ['r1'], basis: 'manual' } },
        ],
      }).application,
    ).toEqual({ state: 'applied', versions: [5] });
  });
});

describe('applyBlockers: what keeps Apply from a report (D6, ADR-0030 R4)', () => {
  const decision = (number: number, recommendation: string, value: 'accepted' | 'rejected') =>
    ({
      taskId: 'T1',
      check: 1,
      number,
      recommendation,
      decision: value,
      createdAt: '2026-10-17T10:00:00.000Z',
    }) satisfies Decision;

  it('lets accepted recommendations of a report that is not stale through', () => {
    expect(
      applyBlockers({
        stale: false,
        decisions: [decision(1, 'r1', 'accepted')],
        recommendations: ['r1'],
      }),
    ).toEqual({ blocked: false, stale: false, notAccepted: [] });
  });

  it('is blocked by staleness, and by a recommendation whose latest decision is not accepted', () => {
    expect(
      applyBlockers({
        stale: true,
        decisions: [decision(1, 'r1', 'accepted'), decision(2, 'r1', 'rejected')],
        recommendations: ['r1', 'r2'],
      }),
    ).toEqual({ blocked: true, stale: true, notAccepted: ['r1', 'r2'] });
  });

  it('takes nothing else: a newer research or a moved repository is no input to it', () => {
    // The signature is the rule: only staleness and the decisions can block (D6).
    expect(
      Object.keys(applyBlockers({ stale: false, decisions: [], recommendations: [] })),
    ).toEqual(['blocked', 'stale', 'notAccepted']);
  });
});

describe('reportKindProblems: a report of the kind its check began as (ADR-0030 R1, R3)', () => {
  const base = { agent: 'a', summary: 's', findings: [], recommendations: [] };

  it('wants a verdict and no markdown from an actuality check', () => {
    expect(reportKindProblems(undefined, { ...base, verdict: 'current' })).toEqual([]);
    expect(reportKindProblems(undefined, base)).toHaveLength(1);
    expect(
      reportKindProblems(undefined, { ...base, verdict: 'current', markdown: '# x' }),
    ).toHaveLength(1);
  });

  it('wants markdown and no verdict from a research, within its limit', () => {
    expect(reportKindProblems('research', { ...base, markdown: '# Notes' })).toEqual([]);
    expect(reportKindProblems('research', base)).toHaveLength(1);
    expect(reportKindProblems('research', { ...base, markdown: '  ' })).toHaveLength(1);
    expect(
      reportKindProblems('research', { ...base, markdown: '# x', verdict: 'current' }),
    ).toHaveLength(1);
    expect(reportKindProblems('research', { ...base, markdown: 'x'.repeat(200_001) })).toHaveLength(
      1,
    );
    expect(reportKindProblems('research', { ...base, markdown: 'x'.repeat(200_000) })).toEqual([]);
  });
});

describe('summarizeComment', () => {
  it('keeps a short comment, and cuts a long one to its first line and a limit', () => {
    expect(summarizeComment('Look at the API.')).toBe('Look at the API.');
    expect(summarizeComment('First line\nsecond line')).toBe('First line…');
    const long = summarizeComment('x'.repeat(500));
    expect(long).toHaveLength(121);
    expect(long.endsWith('…')).toBe(true);
  });
});
