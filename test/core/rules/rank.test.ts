import { BoardError } from '../../../src/core/errors.js';
import {
  compareByRank,
  isValidRank,
  rankForPosition,
  type Ranked,
} from '../../../src/core/rules/rank.js';

function sorted(column: readonly Ranked[]): string[] {
  return [...column].sort(compareByRank).map((t) => t.id);
}

function place(column: Ranked[], id: string, position: Parameters<typeof rankForPosition>[1]) {
  const rank = rankForPosition(column, position, id);
  return [...column.filter((t) => t.id !== id), { id, rank }];
}

describe('isValidRank', () => {
  it.each(['a0', 'a1', 'Zz', 'a0V', 'b00'])('accepts %p', (rank) => {
    expect(isValidRank(rank)).toBe(true);
  });

  it.each(['', 'a', 'A', 'a00', 'zzzz', 'a0 ', 'a0\n', 'a0/'])('rejects %p', (rank) => {
    expect(isValidRank(rank)).toBe(false);
  });
});

describe('compareByRank', () => {
  it('compares by code unit, not locale (Z sorts before a)', () => {
    expect(
      sorted([
        { id: 'T1', rank: 'a0' },
        { id: 'T2', rank: 'Zz' },
      ]),
    ).toEqual(['T2', 'T1']);
  });

  it('breaks rank ties by id so ordering is deterministic', () => {
    expect(
      sorted([
        { id: 'T2', rank: 'a0' },
        { id: 'T1', rank: 'a0' },
      ]),
    ).toEqual(['T1', 'T2']);
  });
});

describe('rankForPosition', () => {
  const column: Ranked[] = [
    { id: 'T3', rank: 'a2' },
    { id: 'T1', rank: 'a0' },
    { id: 'T2', rank: 'a1' },
  ];

  it('gives an empty column a valid rank', () => {
    expect(isValidRank(rankForPosition([], {}))).toBe(true);
  });

  it('appends to the end when no neighbour is given', () => {
    expect(sorted(place(column, 'T9', {}))).toEqual(['T1', 'T2', 'T3', 'T9']);
  });

  it('places the card directly after `after`', () => {
    expect(sorted(place(column, 'T9', { after: 'T1' }))).toEqual(['T1', 'T9', 'T2', 'T3']);
    expect(sorted(place(column, 'T9', { after: 'T3' }))).toEqual(['T1', 'T2', 'T3', 'T9']);
  });

  it('places the card directly before `before`', () => {
    expect(sorted(place(column, 'T9', { before: 'T1' }))).toEqual(['T9', 'T1', 'T2', 'T3']);
    expect(sorted(place(column, 'T9', { before: 'T3' }))).toEqual(['T1', 'T2', 'T9', 'T3']);
  });

  it('places the card between adjacent neighbours', () => {
    expect(sorted(place(column, 'T9', { after: 'T1', before: 'T2' }))).toEqual([
      'T1',
      'T9',
      'T2',
      'T3',
    ]);
  });

  it('with both neighbours, `after` wins when they are not adjacent', () => {
    expect(sorted(place(column, 'T9', { after: 'T1', before: 'T3' }))).toEqual([
      'T1',
      'T9',
      'T2',
      'T3',
    ]);
  });

  it('reorders a card within its own column', () => {
    expect(sorted(place(column, 'T3', { before: 'T1' }))).toEqual(['T3', 'T1', 'T2']);
    expect(sorted(place(column, 'T1', {}))).toEqual(['T2', 'T3', 'T1']);
  });

  it('is idempotent: re-applying the same move does not drift the rank', () => {
    const first = rankForPosition(column, { before: 'T3' }, 'T2');
    const again = rankForPosition(
      [...column.filter((c) => c.id !== 'T2'), { id: 'T2', rank: first }],
      { before: 'T3' },
      'T2',
    );
    expect(again).toBe(first);
  });

  it('keeps strict order under 200 repeated inserts at the same spot', () => {
    let col: Ranked[] = [
      { id: 'A', rank: 'a0' },
      { id: 'Z', rank: 'a1' },
    ];
    const expected = ['A'];
    for (let i = 0; i < 200; i++) {
      const id = `N${i}`;
      col = place(col, id, { before: 'Z' });
      expected.push(id);
    }
    expect(sorted(col)).toEqual([...expected, 'Z']);
    expect(new Set(col.map((t) => t.rank)).size).toBe(col.length);
  });

  it('treats equal ranks (from concurrent creates) as one group instead of failing', () => {
    const tied: Ranked[] = [
      { id: 'T1', rank: 'a0' },
      { id: 'T2', rank: 'a0' },
      { id: 'T3', rank: 'a1' },
    ];
    expect(sorted(place(tied, 'T9', { after: 'T1' }))).toEqual(['T1', 'T2', 'T9', 'T3']);
    expect(sorted(place(tied, 'T9', { before: 'T2' }))).toEqual(['T9', 'T1', 'T2', 'T3']);
  });

  it.each([
    [{ after: 'T404' }, 'NEIGHBOR_NOT_FOUND'],
    [{ before: 'T404' }, 'NEIGHBOR_NOT_FOUND'],
    [{ after: 'T9' }, 'INVALID_POSITION'],
    [{ after: 'T3', before: 'T1' }, 'INVALID_POSITION'],
    [{ after: 'T1', before: 'T1' }, 'INVALID_POSITION'],
  ])('rejects %p with %s', (position, code) => {
    const act = () => rankForPosition(column, position, 'T9');
    expect(act).toThrow(BoardError);
    expect(act).toThrow(expect.objectContaining({ code }));
  });
});
