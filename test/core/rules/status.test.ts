import { BoardError } from '../../../src/core/errors.js';
import {
  assertKnownStatus,
  assertNoOrphanedStatuses,
  findOrphanedStatuses,
  isKnownStatus,
} from '../../../src/core/rules/status.js';

const statuses = ['backlog', 'todo', 'done'];

describe('status rules', () => {
  it('accepts a configured status', () => {
    expect(isKnownStatus('todo', statuses)).toBe(true);
    expect(() => assertKnownStatus('todo', statuses)).not.toThrow();
  });

  it.each(['doing', 'TODO', ' todo', ''])('rejects %p', (status) => {
    expect(isKnownStatus(status, statuses)).toBe(false);
  });

  it('reports the unknown status and the allowed ones', () => {
    expect(() => assertKnownStatus('doing', statuses)).toThrow(BoardError);
    expect(() => assertKnownStatus('doing', statuses)).toThrow(
      expect.objectContaining({
        code: 'UNKNOWN_STATUS',
        details: { status: 'doing', allowed: statuses },
      }),
    );
  });
});

describe('orphaned statuses', () => {
  const tasks = [
    { id: 'T1', status: 'todo' },
    { id: 'T3', status: 'review' },
    { id: 'T7', status: 'review' },
    { id: 'T9', status: 'archived' },
  ];

  it('finds nothing when every task fits the configured statuses', () => {
    expect(findOrphanedStatuses([{ id: 'T1', status: 'todo' }], statuses)).toEqual([]);
  });

  it('groups the tasks whose status is no longer configured', () => {
    expect(findOrphanedStatuses(tasks, statuses)).toEqual([
      { status: 'review', taskIds: ['T3', 'T7'] },
      { status: 'archived', taskIds: ['T9'] },
    ]);
  });

  it('names the status and the tasks in the error (INVARIANT)', () => {
    expect(() => assertNoOrphanedStatuses(tasks, statuses)).toThrow(BoardError);
    let thrown: unknown;
    try {
      assertNoOrphanedStatuses(tasks, statuses);
    } catch (error) {
      thrown = error;
    }
    const error = thrown as BoardError;
    expect(error.code).toBe('ORPHANED_STATUSES');
    expect(error.message).toContain('review');
    expect(error.message).toContain('T3');
    expect(error.message).toContain('T7');
    expect(error.message).toContain('archived');
    expect(error.details).toEqual({
      orphaned: [
        { status: 'review', taskIds: ['T3', 'T7'] },
        { status: 'archived', taskIds: ['T9'] },
      ],
      configured: statuses,
    });
  });

  it('does not throw for a board that fits its config', () => {
    expect(() => assertNoOrphanedStatuses([{ id: 'T1', status: 'done' }], statuses)).not.toThrow();
  });

  it('counts the tasks, so a long list stays readable', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `T${i + 1}`, status: 'review' }));
    const message = (() => {
      try {
        assertNoOrphanedStatuses(many, statuses);
        return '';
      } catch (error) {
        return (error as BoardError).message;
      }
    })();
    expect(message).toContain('12 tasks');
    expect(message.split('\n').length).toBeLessThanOrEqual(4);
  });
});
