import { BoardError } from '../../../src/core/errors.js';
import {
  REPORT_ID_PREFIX,
  allocateId as allocate,
  highestIdNumber,
  idNumber,
  isReportId,
  isTaskId,
  isTaskIdPrefix,
  nextIdAfter,
} from '../../../src/core/rules/ids.js';

describe('task ids', () => {
  it.each(['T1', 'F25', 'ABC123', 'T999999999'])('accepts %p', (id) => {
    expect(isTaskId(id)).toBe(true);
  });

  it.each(['', 'T', '1', 'T0', 'T01', 't1', 'T-1', 'T1 ', '../T1', 'T1/x', 'T1\0', 'T1234567890'])(
    'rejects %p (ids are directory names)',
    (id) => {
      expect(isTaskId(id)).toBe(false);
    },
  );

  it.each(['T', 'F', 'ABC', 'ABCDEFGHIJ'])('accepts prefix %p', (prefix) => {
    expect(isTaskIdPrefix(prefix)).toBe(true);
  });

  it.each(['', 't', 'T1', 'T-', 'ABCDEFGHIJK'])('rejects prefix %p', (prefix) => {
    expect(isTaskIdPrefix(prefix)).toBe(false);
  });
});

describe('idNumber', () => {
  it('reads the number of an id with the given prefix', () => {
    expect(idNumber('T', 'T42')).toBe(42);
  });

  it.each(['F1', 'TA5', 'T01', 't1', 'T', ''])('returns null for %p under prefix T', (id) => {
    expect(idNumber('T', id)).toBeNull();
  });
});

describe('highestIdNumber', () => {
  it('is 0 for an empty board', () => {
    expect(highestIdNumber('T', [])).toBe(0);
  });

  it('compares numerically, not as strings', () => {
    expect(highestIdNumber('T', ['T9', 'T10'])).toBe(10);
  });

  it('ignores ids with another prefix (the prefix was changed in config)', () => {
    expect(highestIdNumber('F', ['T7', 'F4', 'FX9'])).toBe(4);
  });
});

describe('nextIdAfter', () => {
  it('starts at 1', () => {
    expect(nextIdAfter('T', 0)).toBe('T1');
  });

  it('is the sequence + 1', () => {
    expect(nextIdAfter('T', 7)).toBe('T8');
    expect(isTaskId(nextIdAfter('F', 25))).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects sequence %p', (sequence) => {
    expect(() => nextIdAfter('T', sequence)).toThrow(BoardError);
  });

  it('rejects an invalid prefix', () => {
    expect(() => nextIdAfter('t', 0)).toThrow(BoardError);
  });
});

describe('ids are never reused (INVARIANT)', () => {
  it('does not reuse the id of a deleted highest task (regression)', () => {
    let state = { sequence: 0, ids: [] as string[] };
    for (let i = 0; i < 3; i++) {
      const { id, sequence } = allocate('T', state.sequence, state.ids);
      state = { sequence, ids: [...state.ids, id] };
    }
    expect(state.ids).toEqual(['T1', 'T2', 'T3']);

    state = { ...state, ids: state.ids.filter((id) => id !== 'T3') };
    expect(allocate('T', state.sequence, state.ids).id).toBe('T4');
  });

  it('survives a restart: the sequence is read back, not recomputed from the tasks', () => {
    const afterRestart = allocate('T', 3, ['T1']);
    expect(afterRestart.id).toBe('T4');
  });

  it('does not reissue ids after an import into a board with a lower sequence', () => {
    expect(allocate('T', 0, ['T1', 'T9']).id).toBe('T10');
  });

  it('never repeats an id over a long run of creates and deletes', () => {
    const seen = new Set<string>();
    let state = { sequence: 0, ids: [] as string[] };
    for (let i = 0; i < 100; i++) {
      const { id, sequence } = allocate('T', state.sequence, state.ids);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      const ids = [...state.ids, id];
      state = { sequence, ids: i % 3 === 0 ? ids.slice(0, -1) : ids };
    }
    expect(seen.size).toBe(100);
  });
});

describe('report ids', () => {
  it('use the fixed prefix R', () => {
    expect(nextIdAfter(REPORT_ID_PREFIX, 2)).toBe('R3');
    expect(isReportId('R3')).toBe(true);
    expect(isReportId('T3')).toBe(false);
    expect(isReportId('R0')).toBe(false);
  });
});
