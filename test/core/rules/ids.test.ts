import { BoardError } from '../../../src/core/errors.js';
import {
  BLOCK_ID_PREFIX,
  REPORT_ID_PREFIX,
  TOPIC_ID_PREFIX,
  allocateId as allocate,
  allocateRecoverableId,
  highestIdNumber,
  idNumber,
  isBlockId,
  isReportId,
  isReservedTaskIdPrefix,
  isTaskId,
  isTaskIdPrefix,
  isTopicId,
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

describe('topic and block ids (ADR-0032 §2)', () => {
  it('use the fixed prefixes P and K', () => {
    expect(TOPIC_ID_PREFIX).toBe('P');
    expect(BLOCK_ID_PREFIX).toBe('K');
    expect(nextIdAfter(TOPIC_ID_PREFIX, 0)).toBe('P1');
    expect(nextIdAfter(BLOCK_ID_PREFIX, 41)).toBe('K42');
  });

  it.each(['P1', 'P42', 'P999999999'])('accepts topic id %p', (id) => {
    expect(isTopicId(id)).toBe(true);
    expect(isBlockId(id)).toBe(false);
  });

  it.each(['K1', 'K42', 'K999999999'])('accepts block id %p', (id) => {
    expect(isBlockId(id)).toBe(true);
    expect(isTopicId(id)).toBe(false);
  });

  it.each(['', 'P', 'P0', 'P01', 'p1', 'PK1', 'T1', 'P1 ', '../P1', 'P1234567890'])(
    'rejects %p as a topic id (ids are directory names)',
    (id) => {
      expect(isTopicId(id)).toBe(false);
    },
  );

  it.each(['', 'K', 'K0', 'K01', 'k1', 'KP1', 'T1', 'K1/x', 'K1234567890'])(
    'rejects %p as a block id',
    (id) => {
      expect(isBlockId(id)).toBe(false);
    },
  );
});

describe('reserved task id prefixes (ADR-0032 §2, INVARIANT)', () => {
  it.each(['P', 'K'])('reserves %p: a task id would look like a topic or a block id', (prefix) => {
    expect(isReservedTaskIdPrefix(prefix)).toBe(true);
    // The reason: the task id pattern cannot tell them apart.
    expect(isTaskId(`${prefix}3`)).toBe(true);
  });

  it.each(['T', 'F', 'R', 'PK', 'KP', 'PP', 'KK', 'p', 'k'])('does not reserve %p', (prefix) => {
    expect(isReservedTaskIdPrefix(prefix)).toBe(false);
  });
});

describe('allocateRecoverableId: counters that can be lost (ADR-0032 §2, O-1)', () => {
  it('continues the stored counter', () => {
    expect(allocateRecoverableId('P', 3, ['P1'], [])).toEqual({ id: 'P4', sequence: 4 });
  });

  it('does not reuse the highest id after it was deleted (INVARIANT)', () => {
    const first = allocateRecoverableId('K', 2, ['K1', 'K2'], []);
    expect(first.id).toBe('K3');
    // K3 is deleted; the counter remembers it.
    expect(allocateRecoverableId('K', first.sequence, ['K1', 'K2'], []).id).toBe('K4');
  });

  it('is monotonic over a long run of creates and deletes', () => {
    const seen = new Set<string>();
    let state = { sequence: 0, ids: [] as string[] };
    for (let i = 0; i < 50; i++) {
      const { id, sequence } = allocateRecoverableId('P', state.sequence, state.ids, []);
      expect(seen.has(id)).toBe(false);
      expect(sequence).toBeGreaterThan(state.sequence);
      seen.add(id);
      const ids = [...state.ids, id];
      state = { sequence, ids: i % 2 === 0 ? ids.slice(0, -1) : ids };
    }
  });

  it('takes the highest existing id when the counter is behind it', () => {
    expect(allocateRecoverableId('P', 1, ['P1', 'P7'], []).id).toBe('P8');
  });

  it('recovers a missing counter from the ids that exist', () => {
    expect(allocateRecoverableId('K', null, ['K2', 'K5', 'T9', 'P6'], [])).toEqual({
      id: 'K6',
      sequence: 6,
    });
    expect(allocateRecoverableId('P', null, [], []).id).toBe('P1');
  });

  it('refuses when the counter is lost and a topic cannot be read (fail-closed, INVARIANT)', () => {
    const unreadable = ['topics/P2/topic.md'];
    const attempt = (): unknown => allocateRecoverableId('K', null, ['K1'], unreadable);
    expect(attempt).toThrow(BoardError);
    try {
      attempt();
    } catch (error) {
      expect((error as BoardError).code).toBe('ID_SEQUENCE_UNRECOVERABLE');
      expect((error as BoardError).details).toMatchObject({ files: unreadable });
      // The message says what is wrong and what to do about it.
      expect((error as BoardError).message).toContain('topics/P2/topic.md');
      expect((error as BoardError).message).toContain('sequence.json');
    }
  });

  it('refuses for topics as for blocks: either id could repeat', () => {
    expect(() => allocateRecoverableId('P', null, ['P1'], ['topics/P1/topic.md'])).toThrow(
      BoardError,
    );
  });

  it('does not refuse an unreadable topic when the counter is there', () => {
    expect(allocateRecoverableId('K', 4, ['K1'], ['topics/P2/topic.md']).id).toBe('K5');
    expect(allocateRecoverableId('P', 0, [], ['topics/P2/topic.md']).id).toBe('P1');
  });
});
