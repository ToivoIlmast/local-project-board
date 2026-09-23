import { BoardError } from '../../../src/core/errors.js';
import {
  REPORT_ID_PREFIX,
  isReportId,
  isTaskId,
  isTaskIdPrefix,
  nextId,
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

describe('nextId', () => {
  it('starts at 1', () => {
    expect(nextId('T', [])).toBe('T1');
  });

  it('is max + 1, not count + 1', () => {
    expect(nextId('T', ['T1', 'T7', 'T3'])).toBe('T8');
  });

  it('compares numerically, not as strings', () => {
    expect(nextId('T', ['T9', 'T10'])).toBe('T11');
  });

  it('ignores ids with another prefix (the prefix was changed in config)', () => {
    expect(nextId('F', ['T1', 'T2', 'F4', 'FX9'])).toBe('F5');
    expect(nextId('T', ['TA5'])).toBe('T1');
  });

  it('rejects an invalid prefix', () => {
    expect(() => nextId('t', [])).toThrow(BoardError);
  });

  it('produces ids that pass isTaskId', () => {
    expect(isTaskId(nextId('F', ['F25']))).toBe(true);
  });
});

describe('report ids', () => {
  it('use the fixed prefix R', () => {
    expect(nextId(REPORT_ID_PREFIX, ['R1', 'R2'])).toBe('R3');
    expect(isReportId('R3')).toBe(true);
    expect(isReportId('T3')).toBe(false);
    expect(isReportId('R0')).toBe(false);
  });
});
