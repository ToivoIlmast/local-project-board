import { filterByTopic } from '../../../src/web/features/board/index';
import { aTask } from '../support/fixtures';

const inP1 = aTask({ id: 'T1', topic: 'P1' });
const inP1Block = aTask({ id: 'T2', topic: 'P1', block: 'K1' });
const inP2 = aTask({ id: 'T3', topic: 'P2' });
const loose = aTask({ id: 'T4' });
// Its block alone says nothing about a topic: membership is `task.topic`, never inferred.
const tasks = [inP1, inP1Block, inP2, loose];

describe('filtering the board by topic', () => {
  it('shows everything for All, the very collection it was given', () => {
    expect(filterByTopic(tasks, null)).toBe(tasks);
  });

  it('shows only the tasks without a topic for "none"', () => {
    expect(filterByTopic(tasks, 'none')).toEqual([loose]);
  });

  it('shows only the tasks of the selected topic, whatever their block', () => {
    expect(filterByTopic(tasks, 'P1')).toEqual([inP1, inP1Block]);
    expect(filterByTopic(tasks, 'P2')).toEqual([inP2]);
  });

  it('does not take a block for a topic', () => {
    expect(filterByTopic([aTask({ id: 'T9', block: 'K1' })], 'P1')).toEqual([]);
  });

  it('does not turn an unknown or malformed id into All', () => {
    expect(filterByTopic(tasks, 'P99')).toEqual([]);
    expect(filterByTopic(tasks, '')).toEqual([]);
    expect(filterByTopic(tasks, 'banana')).toEqual([]);
  });

  it('changes neither the tasks nor the array it was given', () => {
    const copy = structuredClone(tasks);
    const result = filterByTopic(tasks, 'P1');
    result.pop();
    expect(tasks).toEqual(copy);
    expect(filterByTopic(tasks, 'none')).not.toBe(tasks);
  });
});
