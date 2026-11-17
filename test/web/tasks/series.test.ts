import type { CheckSummary } from '../../../src/contract/v1/index';
import {
  itemState,
  nextUnchecked,
  progress,
  seriesOf,
  triggerOf,
  workingChecks,
  type SeriesRow,
} from '../../../src/web/features/tasks/model/series';
import { aTask } from '../support/fixtures';

/** The series of a completed task: the pair (task, doneAt), and what each task in it has had. */

const DONE_AT = '2026-11-10T10:00:00.000Z';
const series = { task: 'T1', doneAt: DONE_AT };
const trigger = { reason: 'task-done' as const, task: 'T1', doneAt: DONE_AT };

let sequence = 0;
const check = (over: Partial<CheckSummary> = {}): CheckSummary => {
  sequence += 1;
  return {
    taskId: 'T2',
    number: sequence,
    state: 'reported',
    version: 1,
    createdAt: '2026-11-10T11:00:00.000Z',
    agent: 'claude-code',
    trigger,
    ...over,
  };
};

const row = (
  task: string,
  state: SeriesRow['state'],
  excluded?: SeriesRow['excluded'],
): SeriesRow => ({
  task,
  basis: 'block',
  state,
  ...(excluded === undefined ? {} : { excluded }),
});

describe('seriesOf', () => {
  it('is the task and its doneAt', () => {
    expect(seriesOf(aTask({ id: 'T1', doneAt: DONE_AT }))).toEqual(series);
  });
  it('is none without doneAt', () => {
    expect(seriesOf(aTask({ id: 'T1' }))).toBeUndefined();
  });
});

describe('triggerOf', () => {
  it('has no commit unless the run reported one', () => {
    const trig = triggerOf(aTask({ id: 'T1', doneAt: DONE_AT }));
    expect(trig).toEqual(trigger);
    expect(Object.keys(trig ?? {})).not.toContain('commit');
  });
  it('takes the commit of the aiRun', () => {
    const aiRun = { agent: 'claude-code', state: 'finished' as const, commit: 'abc1234' };
    expect(triggerOf(aTask({ id: 'T1', doneAt: DONE_AT, aiRun }))).toEqual({
      ...trigger,
      commit: 'abc1234',
    });
  });
  it('is none without doneAt', () => {
    expect(triggerOf(aTask({ id: 'T1' }))).toBeUndefined();
  });
});

describe('itemState', () => {
  it('a reported check is checked, with no recommendations too', () => {
    expect(itemState([check({ state: 'reported' })], series)).toBe('checked');
  });
  it('failed and working are not checked', () => {
    expect(itemState([check({ state: 'failed' })], series)).toBe('failed');
    expect(itemState([check({ state: 'working' })], series)).toBe('working');
  });
  it('a late reported after working makes it checked (INVARIANT)', () => {
    const early = check({ state: 'working' });
    const late = check({ state: 'reported' });
    expect(itemState([early, late], series)).toBe('checked');
    expect(itemState([late, early], series)).toBe('checked');
  });
  it('a reported one wins over a later failed one', () => {
    expect(itemState([check({ state: 'reported' }), check({ state: 'failed' })], series)).toBe(
      'checked',
    );
  });
  it('the last check decides failed against working', () => {
    expect(itemState([check({ state: 'failed' }), check({ state: 'working' })], series)).toBe(
      'working',
    );
    const first = check({ state: 'working' });
    const last = check({ state: 'failed' });
    expect(itemState([first, last], series)).toBe('failed');
  });
  it('no checks is unchecked', () => {
    expect(itemState([], series)).toBe('unchecked');
  });
  it('another doneAt, another source task or no trigger do not count (INVARIANT)', () => {
    expect(
      itemState([check({ trigger: { ...trigger, doneAt: '2026-11-11T10:00:00.000Z' } })], series),
    ).toBe('unchecked');
    expect(itemState([check({ trigger: { ...trigger, task: 'T9' } })], series)).toBe('unchecked');
    const { trigger: _none, ...bare } = check();
    expect(itemState([bare], series)).toBe('unchecked');
  });
});

describe('workingChecks', () => {
  it('are the working checks of the series, and nothing else', () => {
    const mine = check({ state: 'working' });
    const other = check({ state: 'working', trigger: { ...trigger, task: 'T9' } });
    expect(workingChecks([mine, other, check({ state: 'failed' })], series)).toEqual([mine]);
  });
});

describe('progress', () => {
  it('counts only tasks that are not excluded, and only checked ones', () => {
    const rows = [
      row('T2', 'checked'),
      row('T3', 'working'),
      row('T4', 'failed'),
      row('T5', 'checked', 'done'),
      row('T6', 'unchecked', 'ai-running'),
    ];
    expect(progress(rows)).toEqual({ checked: 1, total: 3 });
  });
});

describe('nextUnchecked', () => {
  it('skips the excluded and the checked, and picks a working or failed one', () => {
    const rows = [
      row('T2', 'checked'),
      row('T3', 'unchecked', 'done'),
      row('T4', 'working'),
      row('T5', 'unchecked'),
    ];
    expect(nextUnchecked(rows)?.task).toBe('T4');
    expect(nextUnchecked([row('T2', 'checked'), row('T3', 'failed')])?.task).toBe('T3');
  });
  it('is none when everything is checked or excluded', () => {
    expect(nextUnchecked([row('T2', 'checked'), row('T3', 'unchecked', 'done')])).toBeUndefined();
  });
});
