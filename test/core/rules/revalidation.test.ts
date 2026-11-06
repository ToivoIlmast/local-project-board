import {
  finishingTask,
  revalidationScope,
  type RevalidationInput,
  type RevalidationTask,
  type ScopeItem,
} from '../../../src/core/rules/revalidation.js';
import { isBlockDone } from '../../../src/core/rules/readiness.js';

const STATUSES = ['backlog', 'todo', 'in-progress', 'done'];
const NO_DONE = ['backlog', 'todo', 'in-progress', 'finished'];

function task(id: string, fields: Partial<Omit<RevalidationTask, 'id'>> = {}): RevalidationTask {
  return { id, status: 'todo', rank: `a${id.replace(/\D/g, '').padStart(4, '0')}`, ...fields };
}

/** A done task in `P1/K1` unless said otherwise. */
function done(id: string, doneAt: string | undefined, fields: Partial<RevalidationTask> = {}) {
  return task(id, {
    status: 'done',
    topic: 'P1',
    block: 'K1',
    ...(doneAt === undefined ? {} : { doneAt }),
    ...fields,
  });
}

function input(
  tasks: RevalidationTask[],
  more: Partial<RevalidationInput> = {},
): RevalidationInput {
  return {
    tasks,
    topics: [{ id: 'P1', blocks: [{ id: 'K1' }, { id: 'K2' }, { id: 'K3' }] }],
    readIssues: [],
    statuses: STATUSES,
    ...more,
  };
}

const ids = (items: readonly ScopeItem[]) => items.map((item) => item.task);
const unreadable = (id: string) => ({ file: `tasks/${id}/task.md`, message: 'Invalid YAML' });

describe('isBlockDone (the predicate of A4)', () => {
  it('needs at least one task and all of them done', () => {
    expect(isBlockDone([])).toBe(false);
    expect(isBlockDone([{ status: 'done' }])).toBe(true);
    expect(isBlockDone([{ status: 'done' }, { status: 'todo' }])).toBe(false);
  });
});

describe('finishingTask: ties on doneAt', () => {
  const at = '2026-11-01T10:00:00.000Z';

  it('is exactly one task when doneAt is equal: the larger id number wins', () => {
    const tasks = [done('T2', at), done('T10', at), done('T9', at)];
    expect(finishingTask(input(tasks), 'P1', 'K1')).toBe('T10');
    // the answer does not depend on the order of the tasks
    expect(finishingTask(input([...tasks].reverse()), 'P1', 'K1')).toBe('T10');
  });

  it('breaks a tie of the numbers by the prefix', () => {
    const tasks = [done('AB5', at), done('ZA5', at), done('M5', at)];
    expect(finishingTask(input(tasks), 'P1', 'K1')).toBe('ZA5');
  });

  it('compares doneAt first: a later doneAt beats a larger id', () => {
    const tasks = [done('T9', at), done('T1', '2026-11-01T10:00:01.000Z')];
    expect(finishingTask(input(tasks), 'P1', 'K1')).toBe('T1');
  });

  it('compares doneAt as moments, not as text', () => {
    const tasks = [done('T1', '2026-11-01T12:00:00.000Z'), done('T2', '2026-11-01T13:00:00+02:00')];
    expect(finishingTask(input(tasks), 'P1', 'K1')).toBe('T1');
  });

  it('puts a task without doneAt before every task with one', () => {
    const tasks = [done('T99', undefined), done('T1', at)];
    expect(finishingTask(input(tasks), 'P1', 'K1')).toBe('T1');
  });

  it('still names one task when none has doneAt', () => {
    const tasks = [done('T3', undefined), done('T7', undefined)];
    expect(finishingTask(input(tasks), 'P1', 'K1')).toBe('T7');
  });

  it('is exactly one of the tasks of the block, and the scope is for that task only', () => {
    const tasks = [done('T1', at), done('T2', at), task('T3', { topic: 'P1', block: 'K2' })];
    expect(ids(revalidationScope(input(tasks), 'T1'))).toEqual([]);
    expect(ids(revalidationScope(input(tasks), 'T2'))).toEqual(['T3']);
  });
});

describe('finishingTask: the block must be done now', () => {
  const at = '2026-11-01T10:00:00.000Z';

  it('is none when the block is empty or unknown', () => {
    expect(finishingTask(input([]), 'P1', 'K1')).toBeUndefined();
    expect(finishingTask(input([done('T1', at)]), 'P1', 'K9')).toBeUndefined();
    expect(finishingTask(input([done('T1', at)]), 'P9', 'K1')).toBeUndefined();
  });

  it('is none while a task of the block is not done', () => {
    const tasks = [done('T1', at), task('T2', { topic: 'P1', block: 'K1' })];
    expect(finishingTask(input(tasks), 'P1', 'K1')).toBeUndefined();
  });

  it('is none when the board has no done status', () => {
    const tasks = [done('T1', at)];
    expect(finishingTask(input(tasks, { statuses: NO_DONE }), 'P1', 'K1')).toBeUndefined();
  });

  it('is none when the topic cannot be read', () => {
    const tasks = [done('T1', at)];
    const topicIssue = { file: 'topics/P1/topic.md', message: 'Invalid YAML' };
    expect(finishingTask(input(tasks, { readIssues: [topicIssue] }), 'P1', 'K1')).toBeUndefined();
  });
});

describe('revalidationScope: C-2, an unreadable task file', () => {
  const at = '2026-11-01T10:00:00.000Z';
  const board = () => [done('T1', at), task('T2', { topic: 'P1', block: 'K2' })];

  it('has no finishing task and no next block while a file cannot be read; both return with it', () => {
    expect(ids(revalidationScope(input(board()), 'T1'))).toEqual(['T2']);

    const broken = input(board(), { readIssues: [unreadable('T50')] });
    expect(finishingTask(broken, 'P1', 'K1')).toBeUndefined();
    expect(revalidationScope(broken, 'T1')).toEqual([]);

    // read again: nothing was kept, so the answer is the first one again
    expect(finishingTask(input(board()), 'P1', 'K1')).toBe('T1');
    expect(ids(revalidationScope(input(board()), 'T1'))).toEqual(['T2']);
  });

  it('is undetermined in every topic, not only where the file might belong', () => {
    const topics = [
      { id: 'P1', blocks: [{ id: 'K1' }, { id: 'K2' }] },
      { id: 'P2', blocks: [{ id: 'K4' }, { id: 'K5' }] },
    ];
    const tasks = [
      done('T1', at, { topic: 'P2', block: 'K4' }),
      task('T2', { topic: 'P2', block: 'K5' }),
    ];
    expect(ids(revalidationScope(input(tasks, { topics }), 'T1'))).toEqual(['T2']);
    const broken = input(tasks, { topics, readIssues: [unreadable('T9')] });
    expect(revalidationScope(broken, 'T1')).toEqual([]);
  });

  it('keeps the direct dependents and the own block, which need no block order', () => {
    const tasks = [
      done('T1', at),
      task('T2', { topic: 'P1', block: 'K1', status: 'done' }),
      task('T3', { dependsOn: ['T1'] }),
      task('T4', { topic: 'P1', block: 'K2' }),
    ];
    const broken = input(tasks, { readIssues: [unreadable('T9')] });
    expect(ids(revalidationScope(broken, 'T1'))).toEqual(['T3']);
  });

  it('ignores an unreadable file that is not a task.md', () => {
    const topicIssue = { file: 'topics/P7/topic.md', message: 'Invalid YAML' };
    expect(ids(revalidationScope(input(board(), { readIssues: [topicIssue] }), 'T1'))).toEqual([
      'T2',
    ]);
  });
});

describe('revalidationScope: a reopened block', () => {
  const at = '2026-11-01T10:00:00.000Z';

  it('does not let the next block in once a task of the block is open again', () => {
    const next = task('T5', { topic: 'P1', block: 'K2' });
    const complete = [done('T1', at), done('T2', '2026-11-01T11:00:00.000Z'), next];
    expect(ids(revalidationScope(input(complete), 'T2'))).toEqual(['T5']);

    const reopened = [done('T1', at), done('T2', '2026-11-01T11:00:00.000Z', { status: 'todo' })];
    expect(ids(revalidationScope(input([...reopened, next]), 'T1'))).toEqual(['T2']);
    expect(ids(revalidationScope(input([...reopened, next]), 'T2'))).toEqual([]);
  });

  it('names the new finisher once the reopened task is done again', () => {
    const next = task('T5', { topic: 'P1', block: 'K2' });
    const again = [
      done('T1', at),
      done('T2', '2026-11-02T09:00:00.000Z', { aiRun: { agent: 'a', state: 'finished' } }),
      next,
    ];
    expect(ids(revalidationScope(input(again), 'T1'))).toEqual([]);
    expect(ids(revalidationScope(input(again), 'T2'))).toEqual(['T5']);
  });
});

describe('revalidationScope: without a topic or a block', () => {
  const at = '2026-11-01T10:00:00.000Z';

  it('has only the direct dependents, and no transitive ones', () => {
    const tasks = [
      task('T1', { status: 'done', doneAt: at }),
      task('T2', { dependsOn: ['T1'] }),
      task('T3', { dependsOn: ['T2'] }),
      task('T4', { topic: 'P1' }),
      task('T5', { topic: 'P1', block: 'K1' }),
    ];
    expect(revalidationScope(input(tasks), 'T1')).toEqual([{ task: 'T2', basis: 'dependent' }]);
  });

  it('has only the dependents for a task with a topic but no block', () => {
    const tasks = [
      task('T1', { status: 'done', topic: 'P1', doneAt: at }),
      task('T2', { topic: 'P1', block: 'K1' }),
      task('T3', { topic: 'P1', dependsOn: ['T1'] }),
    ];
    expect(ids(revalidationScope(input(tasks), 'T1'))).toEqual(['T3']);
  });

  it('has only the dependents when the topic or the block is not known', () => {
    const tasks = [
      done('T1', at, { topic: 'P8', block: 'K1' }),
      task('T2', { topic: 'P8', block: 'K2' }),
      task('T3', { dependsOn: ['T1'] }),
      done('T4', at, { block: 'K9' }),
      task('T5', { topic: 'P1', block: 'K9' }),
    ];
    expect(ids(revalidationScope(input(tasks), 'T1'))).toEqual(['T3']);
    expect(ids(revalidationScope(input(tasks), 'T4'))).toEqual([]);
  });

  it('has no scope for a task that is not on the board', () => {
    expect(revalidationScope(input([task('T1')]), 'T9')).toEqual([]);
  });
});

describe('revalidationScope: what is in it, and in which order', () => {
  const at = '2026-11-01T10:00:00.000Z';

  it('orders dependents, own block, next block, each by rank', () => {
    const tasks = [
      done('T1', at),
      task('T20', { topic: 'P1', block: 'K2', rank: 'a1' }),
      task('T21', { topic: 'P1', block: 'K2', rank: 'a0' }),
      task('T30', { topic: 'P1', block: 'K1', rank: 'a1' }),
      task('T31', { topic: 'P1', block: 'K1', rank: 'a0' }),
      task('T40', { dependsOn: ['T1'], rank: 'a1' }),
      task('T41', { dependsOn: ['T1'], rank: 'a0' }),
      task('T50', { topic: 'P1', block: 'K3', rank: 'a0' }),
    ];
    expect(revalidationScope(input(tasks), 'T1')).toEqual([
      { task: 'T41', basis: 'dependent' },
      { task: 'T40', basis: 'dependent' },
      { task: 'T31', basis: 'block' },
      { task: 'T30', basis: 'block' },
    ]);
  });

  it('adds the next block only for the finishing task, and only the next one', () => {
    const tasks = [
      done('T1', at),
      done('T2', '2026-11-01T11:00:00.000Z'),
      task('T3', { topic: 'P1', block: 'K2' }),
      task('T4', { topic: 'P1', block: 'K3' }),
    ];
    expect(revalidationScope(input(tasks), 'T2')).toEqual([{ task: 'T3', basis: 'next-block' }]);
    expect(revalidationScope(input(tasks), 'T1')).toEqual([]);
  });

  it('has no next block after the last one', () => {
    const tasks = [done('T1', at, { block: 'K3' }), task('T2', { topic: 'P1', block: 'K1' })];
    expect(revalidationScope(input(tasks), 'T1')).toEqual([]);
  });

  it('includes blocked tasks', () => {
    const tasks = [
      done('T1', at),
      task('T2', { topic: 'P1', block: 'K2', dependsOn: ['T77'] }),
      task('T3', { topic: 'P1', block: 'K3' }),
    ];
    expect(ids(revalidationScope(input(tasks), 'T1'))).toEqual(['T2']);
  });

  it('puts a task that depends on it and is in its block in once, as a dependent', () => {
    const tasks = [
      done('T1', at),
      task('T2', { topic: 'P1', block: 'K1', dependsOn: ['T1'], rank: 'a2' }),
      task('T3', { topic: 'P1', block: 'K1', rank: 'a1' }),
      task('T4', { dependsOn: ['T1'], rank: 'a3' }),
    ];
    expect(revalidationScope(input(tasks), 'T1')).toEqual([
      { task: 'T2', basis: 'dependent' },
      { task: 'T4', basis: 'dependent' },
      { task: 'T3', basis: 'block' },
    ]);
  });

  it('puts a task that depends on it and is in the next block in once, as a dependent', () => {
    const tasks = [
      done('T1', at),
      task('T4', { topic: 'P1', block: 'K2', dependsOn: ['T1'], rank: 'a2' }),
      task('T5', { topic: 'P1', block: 'K2', rank: 'a0' }),
    ];
    expect(revalidationScope(input(tasks), 'T1')).toEqual([
      { task: 'T4', basis: 'dependent' },
      { task: 'T5', basis: 'next-block' },
    ]);
  });

  it('does not put the task itself in, even when it depends on itself', () => {
    const tasks = [done('T1', at, { dependsOn: ['T1'] })];
    expect(revalidationScope(input(tasks), 'T1')).toEqual([]);
  });

  it('shows excluded tasks with the reason: done, or an AI run working', () => {
    const tasks = [
      done('T1', at),
      done('T2', at, { dependsOn: ['T1'] }),
      task('T3', { dependsOn: ['T1'], aiRun: { agent: 'a', state: 'working' } }),
      task('T4', { topic: 'P1', block: 'K1', aiRun: { agent: 'a', state: 'working' } }),
      task('T5', { topic: 'P1', block: 'K1', aiRun: { agent: 'a', state: 'finished' } }),
    ];
    const scope = revalidationScope(input(tasks), 'T1');
    expect(scope).toEqual([
      { task: 'T2', basis: 'dependent', excluded: 'done' },
      { task: 'T3', basis: 'dependent', excluded: 'ai-running' },
      { task: 'T4', basis: 'block', excluded: 'ai-running' },
      { task: 'T5', basis: 'block' },
    ]);
  });

  it('does not list done tasks of the own or the next block', () => {
    const tasks = [
      done('T1', at),
      done('T2', '2026-11-01T11:00:00.000Z'),
      task('T3', { topic: 'P1', block: 'K2', status: 'done' }),
      task('T4', { topic: 'P1', block: 'K2' }),
    ];
    // K2 is not the issue here: T3 is done, T4 is open
    expect(ids(revalidationScope(input(tasks), 'T2'))).toEqual(['T4']);
  });

  it('is pure: the input is unchanged and the result is the same on a second call', () => {
    const tasks = [done('T1', at), task('T2', { topic: 'P1', block: 'K2', dependsOn: ['T1'] })];
    const board = input(tasks);
    const before = JSON.stringify(board);
    const first = revalidationScope(board, 'T1');
    expect(revalidationScope(board, 'T1')).toEqual(first);
    expect(JSON.stringify(board)).toBe(before);
  });
});
