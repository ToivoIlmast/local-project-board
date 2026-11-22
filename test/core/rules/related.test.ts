import { selectRelatedTasks, RELATED_GROUP_LIMIT } from '../../../src/core/rules/related.js';
import type { Task } from '../../../src/core/model/task.js';

const make = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Title ${id}`,
  status: 'todo',
  rank: 'a0',
  body: '',
  labels: [],
  createdAt: '2026-09-25T06:35:49.365Z',
  updatedAt: '2026-09-25T06:35:49.365Z',
  ...extra,
});

const ids = (result: ReturnType<typeof selectRelatedTasks>): string[] =>
  result.related.map((entry) => entry.task.id);
const pairs = (result: ReturnType<typeof selectRelatedTasks>): [string, string][] =>
  result.related.map((entry) => [entry.task.id, entry.reason]);

describe('selectRelatedTasks', () => {
  it('returns nothing for a task without structured links', () => {
    const current = make('T1', { labels: ['x'], body: 'see T2' });
    const others = [make('T2', { labels: ['x'], title: current.title }), make('T3')];
    expect(selectRelatedTasks(current, [current, ...others])).toEqual({ related: [], omitted: 0 });
  });

  it('puts direct dependencies first, in the order of dependsOn', () => {
    const current = make('T1', { dependsOn: ['T9', 'T2'] });
    const result = selectRelatedTasks(current, [current, make('T2'), make('T9')]);
    expect(pairs(result)).toEqual([
      ['T9', 'dependency'],
      ['T2', 'dependency'],
    ]);
  });

  it('skips a dependency that is not readable, without failing', () => {
    const current = make('T1', { dependsOn: ['T5', 'T2'] });
    expect(ids(selectRelatedTasks(current, [current, make('T2')]))).toEqual(['T2']);
  });

  it('takes the block, then the rest of the topic, and never the task itself', () => {
    const current = make('T1', { topic: 'P1', block: 'K1' });
    const all = [
      current,
      make('T2', { topic: 'P1' }),
      make('T3', { topic: 'P1', block: 'K1' }),
      make('T4', { topic: 'P1', block: 'K2' }),
      make('T5', { topic: 'P2', block: 'K1' }),
    ];
    expect(pairs(selectRelatedTasks(current, all))).toEqual([
      ['T3', 'block'],
      ['T2', 'topic'],
      ['T4', 'topic'],
    ]);
  });

  it('lists a task once, with the reason of the highest priority', () => {
    const current = make('T1', { topic: 'P1', block: 'K1', dependsOn: ['T2'] });
    const all = [current, make('T2', { topic: 'P1', block: 'K1', dependsOn: ['T1'] })];
    expect(pairs(selectRelatedTasks(current, all))).toEqual([['T2', 'dependency']]);
  });

  it('adds the tasks that depend on this one, after block and topic', () => {
    const current = make('T1', { topic: 'P1' });
    const all = [current, make('T2', { dependsOn: ['T1'] }), make('T3', { topic: 'P1' })];
    expect(pairs(selectRelatedTasks(current, all))).toEqual([
      ['T3', 'topic'],
      ['T2', 'dependent'],
    ]);
  });

  it('does not follow dependencies of dependencies', () => {
    const current = make('T1', { dependsOn: ['T2'] });
    const all = [current, make('T2', { dependsOn: ['T3'] }), make('T3')];
    expect(ids(selectRelatedTasks(current, all))).toEqual(['T2']);
  });

  it('keeps archived tasks', () => {
    const current = make('T1', { dependsOn: ['T2'] });
    const archived = make('T2', { status: 'done', archived: { at: '2026-09-26T00:00:00.000Z' } });
    expect(ids(selectRelatedTasks(current, [current, archived]))).toEqual(['T2']);
  });

  it('limits block, topic and dependents together and says how many are left', () => {
    const current = make('T1', { topic: 'P1' });
    const many = Array.from({ length: RELATED_GROUP_LIMIT + 3 }, (_, index) =>
      make(`T${index + 2}`, { topic: 'P1' }),
    );
    const result = selectRelatedTasks(current, [current, ...many]);
    expect(result.related).toHaveLength(RELATED_GROUP_LIMIT);
    expect(result.omitted).toBe(3);
    expect(ids(result)[0]).toBe('T2');
  });

  it('does not limit dependencies', () => {
    const deps = Array.from({ length: RELATED_GROUP_LIMIT + 2 }, (_, index) => `T${index + 2}`);
    const current = make('T1', { dependsOn: deps });
    const result = selectRelatedTasks(current, [current, ...deps.map((id) => make(id))]);
    expect(result.related).toHaveLength(deps.length);
    expect(result.omitted).toBe(0);
  });
});
