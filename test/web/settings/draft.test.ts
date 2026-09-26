import {
  WORKFLOW_FLAGS,
  type WorkflowFlag,
  type WorkflowOverrides,
} from '../../../src/contract/v1/index';
import { defaultWorkflow, resolveWorkflow } from '../../../src/core/rules/workflow';
import {
  INACTIVE_WITHOUT_EDIT_CODE,
  effectiveFlag,
  normalizeOverrides,
  orphanStatuses,
  sameOverrides,
  setBoardFlag,
  setBoardValue,
  setColumnFlag,
} from '../../../src/web/features/settings/model/draft';
import { STATUSES } from '../support/fixtures';

const defaults = defaultWorkflow(STATUSES);
const empty = (): WorkflowOverrides => ({ board: {}, statuses: {} });

describe('the settings form works on overrides, never on effective values', () => {
  it('says the same as resolveWorkflow about the value and where it comes from (INVARIANT)', () => {
    const levels = [undefined, true, false] as const;
    for (const key of WORKFLOW_FLAGS) {
      for (const board of levels) {
        for (const column of levels) {
          const overrides: WorkflowOverrides = {
            board: board === undefined ? {} : { [key]: board },
            statuses: column === undefined ? {} : { todo: { [key]: column } },
          };
          const expected = resolveWorkflow(
            defaults,
            overrides.board,
            overrides.statuses['todo'],
            undefined,
          );

          const seen = effectiveFlag(overrides, defaults, key, 'todo');

          expect({ value: seen.value, source: seen.source }).toEqual({
            value: expected.values[key],
            source: expected.sources[key],
          });
        }
      }
    }
  });

  it('reads a board-level flag as the board setting, or else the default', () => {
    expect(effectiveFlag(empty(), defaults, 'push')).toEqual({ value: false, source: 'default' });
    expect(effectiveFlag({ board: { push: true }, statuses: {} }, defaults, 'push')).toEqual({
      value: true,
      source: 'board',
    });
  });

  it('lists as inactive exactly what resolveWorkflow lists while editCode is off (INVARIANT)', () => {
    const off = resolveWorkflow(defaults, { editCode: false }, undefined, undefined);
    const on = resolveWorkflow(defaults, {}, undefined, undefined);

    expect(off.inactive).toEqual([...INACTIVE_WITHOUT_EDIT_CODE]);
    expect(on.inactive).toEqual([]);
  });

  it('removes the override of a column when it is set back to "as the board"', () => {
    const start: WorkflowOverrides = {
      board: {},
      statuses: { todo: { push: true, checks: false } },
    };

    const one = setColumnFlag(start, 'todo', 'push', 'inherit');
    expect(one.statuses).toEqual({ todo: { checks: false } });

    const none = setColumnFlag(one, 'todo', 'checks', 'inherit');
    // A column with nothing left to say is not kept as an empty object.
    expect(none.statuses).toEqual({});
  });

  it('sets a column flag to an explicit value, on or off', () => {
    const on = setColumnFlag(empty(), 'todo', 'push', true);
    const off = setColumnFlag(on, 'todo', 'push', false);

    expect(on.statuses).toEqual({ todo: { push: true } });
    expect(off.statuses).toEqual({ todo: { push: false } });
  });

  it('does not store a board flag that only repeats the default', () => {
    const changed = setBoardFlag(empty(), 'push', true, defaults);
    expect(changed.board).toEqual({ push: true });

    const back = setBoardFlag(changed, 'push', false, defaults);
    expect(back.board).toEqual({});
  });

  it('never changes what it is given', () => {
    const start: WorkflowOverrides = { board: { push: true }, statuses: { todo: { push: true } } };
    const copy = structuredClone(start);

    setBoardFlag(start, 'commit', false, defaults);
    setColumnFlag(start, 'todo', 'push', 'inherit');
    setBoardValue(start, 'baseBranch', 'develop');

    expect(start).toEqual(copy);
  });

  it('keeps null as a value of its own and an absent key as another', () => {
    const start: WorkflowOverrides = { board: { finishStatus: null }, statuses: {} };

    // Untouched fields are carried along, null included.
    expect(setBoardFlag(start, 'commit', false, defaults).board).toEqual({
      finishStatus: null,
      commit: false,
    });
    expect(setBoardValue(start, 'startStatus', null).board).toEqual({
      finishStatus: null,
      startStatus: null,
    });
    // `undefined` is the way to say "no override at all".
    expect(setBoardValue(start, 'finishStatus', undefined).board).toEqual({});
  });

  it('keeps a text as it is typed, and only the empty text is no override', () => {
    const start: WorkflowOverrides = { board: { baseBranch: 'develop' }, statuses: {} };

    expect(setBoardValue(start, 'baseBranch', '').board).toEqual({});
    // Called on every key: the space between two words must survive being typed.
    expect(setBoardValue(empty(), 'checkCommand', 'npm ').board).toEqual({ checkCommand: 'npm ' });
  });

  it('sends a text without the spaces around it, and a blank one not at all', () => {
    const typed: WorkflowOverrides = {
      board: { baseBranch: '   ', checkCommand: ' npm test ', finishStatus: null },
      statuses: { todo: {}, done: { push: true } },
    };

    expect(normalizeOverrides(typed)).toEqual({
      board: { checkCommand: 'npm test', finishStatus: null },
      statuses: { done: { push: true } },
    });
    // Nothing is changed in what was given.
    expect(typed.board.baseBranch).toBe('   ');
    expect(sameOverrides(typed, normalizeOverrides(typed))).toBe(true);
  });

  it('compares overrides without minding the order of keys or an empty column', () => {
    const a: WorkflowOverrides = { board: { push: true, commit: false }, statuses: {} };
    const b: WorkflowOverrides = {
      board: { commit: false, push: true },
      statuses: { todo: {} },
    };

    expect(sameOverrides(a, b)).toBe(true);
    expect(sameOverrides(a, setBoardFlag(b, 'report', false, defaults))).toBe(false);
    // null is not the same as missing.
    expect(
      sameOverrides({ board: { finishStatus: null }, statuses: {} }, { board: {}, statuses: {} }),
    ).toBe(false);
  });

  it('finds the columns and statuses that the board no longer has', () => {
    const overrides: WorkflowOverrides = {
      board: { startStatus: 'gone', finishStatus: 'done' },
      statuses: { todo: { push: true }, archive: { push: true } },
    };

    expect(orphanStatuses(overrides, STATUSES)).toEqual({
      columns: ['archive'],
      board: [{ key: 'startStatus', status: 'gone' }],
    });
    expect(orphanStatuses(empty(), STATUSES)).toEqual({ columns: [], board: [] });
  });

  it('only ever offers the flags to a column', () => {
    // A column has no way to be given a board-only key: the function takes a flag.
    const flag: WorkflowFlag = 'editCode';
    expect(Object.keys(setColumnFlag(empty(), 'todo', flag, false).statuses['todo'] ?? {})).toEqual(
      ['editCode'],
    );
  });
});
