import { readiness } from '../../../src/contract/v1/index';
import { ApiError } from '../../../src/web/api/index';
import { explainError } from '../../../src/web/features/tasks/model/explainError';
import {
  blockSummary,
  blockOptions,
  describeMove,
  needsStatusConfirmation,
} from '../../../src/web/features/tasks/model/placement';
import { STATUSES, aTask, aTopic } from '../support/fixtures';

const alpha = aTopic({
  id: 'P1',
  title: 'Alpha',
  blocks: [
    { id: 'K1', title: 'Design' },
    { id: 'K2', title: 'Build' },
  ],
});
const beta = aTopic({
  id: 'P2',
  title: 'Beta',
  blocks: [
    { id: 'K3', title: 'Prepare' },
    { id: 'K4', title: 'Ship' },
  ],
});

const board = (tasks: ReturnType<typeof aTask>[]) => ({
  tasks,
  topics: [alpha, beta],
  readIssues: [],
  statuses: STATUSES,
});

describe('the block options of a topic', () => {
  it('are the blocks of that topic in their order, and none without a topic', () => {
    expect(blockOptions([alpha, beta], 'P2').map((block) => block.id)).toEqual(['K3', 'K4']);
    expect(blockOptions([alpha, beta], undefined)).toEqual([]);
    expect(blockOptions([alpha, beta], 'P9')).toEqual([]);
  });
});

describe('when a status change of a task needs a confirmation (ADR-0032 §8)', () => {
  const reasons = [{ code: 'task-not-done', task: 'T9' }] as const;

  it('does, for a blocked task moved to another status', () => {
    expect(needsStatusConfirmation(aTask({ status: 'todo' }), reasons, 'in-progress')).toBe(true);
    expect(needsStatusConfirmation(aTask({ status: 'todo' }), reasons, 'done')).toBe(true);
  });

  it('does not, for the same status: a reorder is not a status change', () => {
    expect(needsStatusConfirmation(aTask({ status: 'todo' }), reasons, 'todo')).toBe(false);
  });

  it('does not, for a task that is not blocked', () => {
    expect(needsStatusConfirmation(aTask({ status: 'todo' }), [], 'done')).toBe(false);
  });

  it('does not, for a task that is done: it is not blocked', () => {
    expect(needsStatusConfirmation(aTask({ status: 'done' }), reasons, 'todo')).toBe(false);
  });
});

describe('the summary of a block', () => {
  const inBlock = (id: string, status: string, block = 'K2', topic = 'P1') =>
    aTask({ id, status, topic, block });

  const summary = (tasks: ReturnType<typeof aTask>[], block: string) => {
    const reasons = readiness(board(tasks));
    return blockSummary(
      tasks.filter((task) => task.block === block),
      reasons,
    );
  };

  it('is completed when it has tasks and all are done', () => {
    const tasks = [inBlock('T1', 'done', 'K1'), inBlock('T2', 'done', 'K1')];
    expect(summary(tasks, 'K1')).toEqual({ done: 2, total: 2, state: 'completed' });
  });

  it('is empty when it has no tasks', () => {
    expect(summary([], 'K1')).toEqual({ done: 0, total: 0, state: 'empty' });
  });

  it('is waiting for the previous block when its open tasks are held by an earlier block', () => {
    const tasks = [inBlock('T1', 'todo', 'K1'), inBlock('T2', 'todo', 'K2')];
    expect(summary(tasks, 'K2')).toEqual({ done: 0, total: 1, state: 'waiting' });
  });

  it('has exactly one state: empty wins over waiting, completed wins over waiting', () => {
    const emptyBehind = [inBlock('T1', 'todo', 'K1')];
    expect(summary(emptyBehind, 'K2').state).toBe('empty');
    const doneBehind = [inBlock('T1', 'todo', 'K1'), inBlock('T2', 'done', 'K2')];
    expect(summary(doneBehind, 'K2').state).toBe('completed');
  });

  it('has no state of the three when it is under way and nothing holds it', () => {
    const tasks = [inBlock('T1', 'done', 'K1'), inBlock('T2', 'todo', 'K1')];
    expect(summary(tasks, 'K1')).toEqual({ done: 1, total: 2, state: undefined });
  });
});

describe('what a move between topics or blocks would change', () => {
  const t1 = aTask({ id: 'T1', title: 'Moving', status: 'todo', topic: 'P1', block: 'K1' });
  const t2 = aTask({ id: 'T2', status: 'todo', topic: 'P1', block: 'K2' });
  const t3 = aTask({ id: 'T3', status: 'todo', topic: 'P2', block: 'K3' });
  const t4 = aTask({ id: 'T4', status: 'done', topic: 'P2', block: 'K4' });
  const tasks = [t1, t2, t3, t4];

  it('is nothing when the topic and the block stay', () => {
    expect(describeMove(board(tasks), 'T1', { topic: 'P1', block: 'K1' })).toBeUndefined();
  });

  it('names the old and the new place with their titles', () => {
    const move = describeMove(board(tasks), 'T1', { topic: 'P2', block: 'K4' });

    expect(move?.from).toBe('P1 · Alpha / K1 · Design');
    expect(move?.to).toBe('P2 · Beta / K4 · Ship');
  });

  it('says what readiness becomes, by the very function the board uses', () => {
    const move = describeMove(board(tasks), 'T1', { topic: 'P2', block: 'K4' });

    expect(move?.before).toEqual([]);
    expect(move?.after).toEqual(['block K3 is not done: T3']);
  });

  it('says what happens to the order of blocks on both sides', () => {
    const move = describeMove(board(tasks), 'T1', { topic: 'P2', block: 'K4' });
    const lines = move?.blocks.join('\n') ?? '';

    // The block it leaves had only this task: empty, and it holds K2 behind it.
    expect(lines).toContain('K1');
    expect(lines).toContain('empty');
    // It lands in K4, which comes after K3 in P2.
    expect(lines).toContain('K4');
    expect(lines).toContain('K3');
  });

  it('says a done block is reopened by a task that is not done', () => {
    const move = describeMove(board(tasks), 'T1', { topic: 'P2', block: 'K4' });

    expect(move?.blocks.join('\n')).toContain('K4 is no longer done');
  });

  it('says a task without a topic is outside the order of blocks', () => {
    const move = describeMove(board(tasks), 'T1', {});

    expect(move?.to).toBe('no topic');
    expect(move?.after).toEqual([]);
    expect(move?.blocks.join('\n')).toContain('outside the order');
  });
});

describe('what the page says of a refusal', () => {
  it('words the reasons of TASK_BLOCKED, not only the generic message', () => {
    const error = new ApiError(409, 'TASK_BLOCKED', 'Task "T2" is blocked.', {
      id: 'T2',
      reasons: [
        { code: 'task-not-done', task: 'T1' },
        { code: 'block-empty', topic: 'P1', block: 'K1' },
      ],
    });

    const explained = explainError(error);

    expect(explained.message).toContain('T1 is not done');
    expect(explained.message).toContain('block K1 has no tasks');
  });

  it('leaves every other error as it was', () => {
    const error = new ApiError(500, 'INTERNAL_ERROR', 'It broke.');

    expect(explainError(error)).toBe(error);
    const plain = new Error('plain');
    expect(explainError(plain)).toBe(plain);
  });
});
