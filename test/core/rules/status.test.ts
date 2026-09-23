import { BoardError } from '../../../src/core/errors.js';
import { assertKnownStatus, isKnownStatus } from '../../../src/core/rules/status.js';

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
