import {
  findCycles,
  launchState,
  readiness,
  type BlockingReason,
  type ReadinessInput,
  type ReadinessTask,
  type ReadinessTopic,
} from '../../../src/core/rules/readiness.js';

const STATUSES = ['backlog', 'todo', 'in-progress', 'done'];
const NO_DONE = ['backlog', 'todo', 'in-progress', 'finished'];

function task(id: string, fields: Partial<Omit<ReadinessTask, 'id'>> = {}): ReadinessTask {
  return { id, status: 'todo', ...fields };
}

function topic(id: string, ...blocks: string[]): ReadinessTopic {
  return { id, blocks: blocks.map((block) => ({ id: block })) };
}

const unreadableTask = (id: string) => ({ file: `tasks/${id}/task.md`, message: 'Invalid YAML' });
const unreadableTopic = (id: string) => ({
  file: `topics/${id}/topic.md`,
  message: 'Invalid YAML',
});

function board(input: Partial<ReadinessInput>): Record<string, BlockingReason[]> {
  return readiness({ tasks: [], topics: [], readIssues: [], statuses: STATUSES, ...input });
}

const codes = (reasons: readonly BlockingReason[] | undefined) =>
  (reasons ?? []).map((reason) => reason.code);

describe('readiness: each reason', () => {
  it('task-not-done: a dependency that is not done', () => {
    const result = board({ tasks: [task('T1'), task('T2', { dependsOn: ['T1'] })] });
    expect(result.T2).toEqual([{ code: 'task-not-done', task: 'T1' }]);
    expect(result.T1).toEqual([]);
  });

  it('a dependency that is done blocks nothing', () => {
    const result = board({
      tasks: [task('T1', { status: 'done' }), task('T2', { dependsOn: ['T1'] })],
    });
    expect(result.T2).toEqual([]);
  });

  it('task-missing: a dependency that is not on the board', () => {
    const result = board({ tasks: [task('T2', { dependsOn: ['T9'] })] });
    expect(result.T2).toEqual([{ code: 'task-missing', task: 'T9' }]);
  });

  it('task-unreadable: a dependency whose task.md cannot be read, not a missing one', () => {
    const result = board({
      tasks: [task('T2', { dependsOn: ['T7'] })],
      readIssues: [unreadableTask('T7')],
    });
    expect(result.T2).toEqual([{ code: 'task-unreadable', task: 'T7' }]);
  });

  it('topic-missing: the topic file of the task is not there', () => {
    const result = board({ tasks: [task('T1', { topic: 'P1', block: 'K1' })] });
    expect(result.T1).toEqual([{ code: 'topic-missing', topic: 'P1' }]);
  });

  it('topic-missing: also for a task with a topic and no block', () => {
    const result = board({ tasks: [task('T1', { topic: 'P1' })] });
    expect(result.T1).toEqual([{ code: 'topic-missing', topic: 'P1' }]);
  });

  it('topic-unreadable: the topic file is there and cannot be read, not a missing one', () => {
    const result = board({
      tasks: [task('T1', { topic: 'P1', block: 'K1' })],
      readIssues: [unreadableTopic('P1')],
    });
    expect(result.T1).toEqual([{ code: 'topic-unreadable', topic: 'P1' }]);
  });

  it('block-missing: the topic does not hold the block of the task', () => {
    const result = board({
      tasks: [task('T1', { topic: 'P1', block: 'K5' })],
      topics: [topic('P1', 'K1')],
    });
    expect(result.T1).toEqual([{ code: 'block-missing', topic: 'P1', block: 'K5' }]);
  });

  it('block-incomplete: a previous block with a task that is not done', () => {
    const result = board({
      tasks: [
        task('T1', { topic: 'P1', block: 'K1' }),
        task('T3', { topic: 'P1', block: 'K1', status: 'done' }),
        task('T2', { topic: 'P1', block: 'K2' }),
      ],
      topics: [topic('P1', 'K1', 'K2')],
    });
    expect(result.T2).toEqual([
      { code: 'block-incomplete', topic: 'P1', block: 'K1', tasks: ['T1'] },
    ]);
    expect(result.T1).toEqual([]);
  });

  it('a previous block whose tasks are all done blocks nothing', () => {
    const result = board({
      tasks: [
        task('T1', { topic: 'P1', block: 'K1', status: 'done' }),
        task('T2', { topic: 'P1', block: 'K2' }),
      ],
      topics: [topic('P1', 'K1', 'K2')],
    });
    expect(result.T2).toEqual([]);
  });

  it('block-empty: a previous block with no tasks, not an incomplete one', () => {
    const result = board({
      tasks: [task('T2', { topic: 'P1', block: 'K2' })],
      topics: [topic('P1', 'K1', 'K2')],
    });
    expect(result.T2).toEqual([{ code: 'block-empty', topic: 'P1', block: 'K1' }]);
  });

  it('block-order-unknown: an unreadable task.md hides where that task sits', () => {
    const result = board({
      tasks: [
        task('T1', { topic: 'P1', block: 'K1', status: 'done' }),
        task('T2', { topic: 'P1', block: 'K2' }),
      ],
      topics: [topic('P1', 'K1', 'K2')],
      readIssues: [unreadableTask('T7')],
    });
    expect(result.T2).toEqual([{ code: 'block-order-unknown', tasks: ['T7'] }]);
  });

  it('cycle: every task of the cycle', () => {
    const result = board({
      tasks: [task('T1', { dependsOn: ['T2'] }), task('T2', { dependsOn: ['T1'] })],
    });
    expect(result.T1).toContainEqual({ code: 'cycle', tasks: ['T1', 'T2'] });
    expect(result.T2).toContainEqual({ code: 'cycle', tasks: ['T1', 'T2'] });
  });

  it('config: without a done status, a task with dependencies', () => {
    const result = board({
      statuses: NO_DONE,
      tasks: [task('T1'), task('T2', { dependsOn: ['T1'] })],
    });
    expect(result.T2).toEqual([{ code: 'config', status: 'done' }]);
  });
});

describe('readiness: unreadable task files', () => {
  const topics = [topic('P1', 'K1', 'K2', 'K3'), topic('P2', 'K4', 'K5')];
  const tasks = [
    task('T1', { topic: 'P1', block: 'K1', status: 'done' }),
    task('T2', { topic: 'P1', block: 'K2', status: 'done' }),
    task('T3', { topic: 'P1', block: 'K3' }),
    task('T4', { topic: 'P2', block: 'K4', status: 'done' }),
    task('T5', { topic: 'P2', block: 'K5' }),
    task('T6', { topic: 'P2' }),
    task('T8'),
  ];
  const broken = board({ tasks, topics, readIssues: [unreadableTask('T7')] });

  it('blocks the tasks of the second and later blocks in every topic', () => {
    for (const id of ['T2', 'T3', 'T5']) {
      expect(broken[id]).toEqual([{ code: 'block-order-unknown', tasks: ['T7'] }]);
    }
  });

  it('leaves the tasks of a first block without dependencies alone', () => {
    expect(broken.T1).toEqual([]);
    expect(broken.T4).toEqual([]);
  });

  it('leaves a task of a topic without a block alone', () => {
    expect(broken.T6).toEqual([]);
  });

  it('leaves a task without a topic alone', () => {
    expect(broken.T8).toEqual([]);
  });

  it('is gone once the file can be read again, with nothing kept', () => {
    const fixed = board({
      tasks: [...tasks, task('T7', { topic: 'P2', block: 'K4', status: 'done' })],
      topics,
    });
    for (const id of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']) {
      expect(codes(fixed[id])).not.toContain('block-order-unknown');
    }
    expect(fixed.T2).toEqual([]);
    expect(fixed.T5).toEqual([]);
  });

  it('names every unreadable task', () => {
    const result = board({
      tasks,
      topics,
      readIssues: [unreadableTask('T7'), unreadableTask('T9')],
    });
    expect(result.T3).toContainEqual({ code: 'block-order-unknown', tasks: ['T7', 'T9'] });
  });

  it('only counts task.md: an unreadable history file hides no task', () => {
    const result = board({
      tasks,
      topics,
      readIssues: [{ file: 'tasks/T9/history/versions/1.json' }],
    });
    expect(result.T2).toEqual([]);
  });

  it('tells an unreadable dependency apart from the unknown order', () => {
    const result = board({
      tasks: [...tasks, task('T9', { topic: 'P1', block: 'K2', dependsOn: ['T7'] })],
      topics,
      readIssues: [unreadableTask('T7')],
    });
    expect(result.T9).toEqual([
      { code: 'block-order-unknown', tasks: ['T7'] },
      { code: 'task-unreadable', task: 'T7' },
    ]);
  });
});

describe('readiness: without a done status', () => {
  const topics = [topic('P1', 'K1', 'K2')];

  it('blocks a task with dependencies', () => {
    const result = board({
      statuses: NO_DONE,
      tasks: [task('T1', { status: 'finished' }), task('T2', { dependsOn: ['T1'] })],
    });
    expect(result.T2).toEqual([{ code: 'config', status: 'done' }]);
  });

  it('blocks a task of a block that is not the first', () => {
    const result = board({
      statuses: NO_DONE,
      topics,
      tasks: [
        task('T1', { topic: 'P1', block: 'K1', status: 'finished' }),
        task('T2', { topic: 'P1', block: 'K2' }),
      ],
    });
    expect(result.T2).toEqual([{ code: 'config', status: 'done' }]);
  });

  it('does not block a task without dependencies and without a block', () => {
    const result = board({
      statuses: NO_DONE,
      topics,
      tasks: [task('T1'), task('T2', { topic: 'P1' })],
    });
    expect(result.T1).toEqual([]);
    expect(result.T2).toEqual([]);
  });

  it('does not block a task of the first block without dependencies', () => {
    const result = board({
      statuses: NO_DONE,
      topics,
      tasks: [task('T1', { topic: 'P1', block: 'K1' })],
    });
    expect(result.T1).toEqual([]);
  });

  it('keeps reporting what does not need a done status', () => {
    const result = board({
      statuses: NO_DONE,
      topics,
      tasks: [task('T2', { topic: 'P1', block: 'K2', dependsOn: ['T9'] })],
    });
    expect(result.T2).toEqual([
      { code: 'config', status: 'done' },
      { code: 'block-empty', topic: 'P1', block: 'K1' },
      { code: 'task-missing', task: 'T9' },
    ]);
  });
});

describe('readiness: order of blocks and dependencies', () => {
  it('checks every previous block, not only the one before', () => {
    const result = board({
      topics: [topic('P1', 'K1', 'K2', 'K3')],
      tasks: [
        task('T1', { topic: 'P1', block: 'K1' }),
        task('T2', { topic: 'P1', block: 'K2', status: 'done' }),
        task('T3', { topic: 'P1', block: 'K3' }),
      ],
    });
    expect(result.T3).toEqual([
      { code: 'block-incomplete', topic: 'P1', block: 'K1', tasks: ['T1'] },
    ]);
  });

  it('blocks the later blocks again when an earlier one is reopened', () => {
    const topics = [topic('P1', 'K1', 'K2', 'K3')];
    const placed = (status: string) => [
      task('T1', { topic: 'P1', block: 'K1', status }),
      task('T2', { topic: 'P1', block: 'K2', status: 'done' }),
      task('T3', { topic: 'P1', block: 'K3' }),
    ];
    expect(board({ topics, tasks: placed('done') }).T3).toEqual([]);
    const reopened = board({ topics, tasks: placed('in-progress') });
    expect(reopened.T2).toEqual([
      { code: 'block-incomplete', topic: 'P1', block: 'K1', tasks: ['T1'] },
    ]);
    expect(reopened.T3).toEqual([
      { code: 'block-incomplete', topic: 'P1', block: 'K1', tasks: ['T1'] },
    ]);
  });

  it('leaves the tasks of a topic without a block out of the order of blocks', () => {
    const result = board({
      topics: [topic('P1', 'K1', 'K2')],
      tasks: [
        task('T1', { topic: 'P1' }),
        task('T2', { topic: 'P1', block: 'K1', status: 'done' }),
        task('T3', { topic: 'P1', block: 'K2' }),
      ],
    });
    expect(result.T3).toEqual([]);
    expect(result.T1).toEqual([]);
  });

  it('counts only direct dependencies', () => {
    const result = board({
      tasks: [
        task('T1'),
        task('T2', { status: 'done', dependsOn: ['T1'] }),
        task('T3', { dependsOn: ['T2'] }),
      ],
    });
    expect(result.T3).toEqual([]);
    expect(result.T2).toEqual([{ code: 'task-not-done', task: 'T1' }]);
  });

  it('follows a dependency into another topic', () => {
    const topics = [topic('P1', 'K1'), topic('P2', 'K2')];
    const placed = (status: string) => [
      task('T1', { topic: 'P1', block: 'K1', status }),
      task('T2', { topic: 'P2', block: 'K2', dependsOn: ['T1'] }),
    ];
    expect(board({ topics, tasks: placed('todo') }).T2).toEqual([
      { code: 'task-not-done', task: 'T1' },
    ]);
    expect(board({ topics, tasks: placed('done') }).T2).toEqual([]);
  });

  it('names a dependency listed twice once', () => {
    const result = board({ tasks: [task('T1'), task('T2', { dependsOn: ['T1', 'T1'] })] });
    expect(result.T2).toEqual([{ code: 'task-not-done', task: 'T1' }]);
  });
});

describe('readiness: cycles', () => {
  it('does not mark a task that only depends on a cycle', () => {
    const result = board({
      tasks: [
        task('T1', { dependsOn: ['T2'] }),
        task('T2', { dependsOn: ['T1'] }),
        task('T3', { dependsOn: ['T1'] }),
      ],
    });
    expect(result.T3).toEqual([{ code: 'task-not-done', task: 'T1' }]);
  });

  it('a task that depends on itself is a cycle', () => {
    const result = board({ tasks: [task('T1', { dependsOn: ['T1'] })] });
    expect(result.T1).toContainEqual({ code: 'cycle', tasks: ['T1'] });
  });

  it('marks a cycle of done tasks too', () => {
    const result = board({
      tasks: [
        task('T1', { status: 'done', dependsOn: ['T2'] }),
        task('T2', { status: 'done', dependsOn: ['T1'] }),
      ],
    });
    expect(result.T1).toEqual([{ code: 'cycle', tasks: ['T1', 'T2'] }]);
  });

  it('finds each cycle with its members only', () => {
    const cycles = findCycles([
      task('T1', { dependsOn: ['T2'] }),
      task('T2', { dependsOn: ['T3'] }),
      task('T3', { dependsOn: ['T1', 'T9'] }),
      task('T4', { dependsOn: ['T1'] }),
      task('T5', { dependsOn: ['T6'] }),
      task('T6', { dependsOn: ['T5'] }),
      task('T7', { dependsOn: ['T7'] }),
      task('T8'),
    ]);
    expect(cycles.map((members) => [...members].sort())).toEqual(
      expect.arrayContaining([['T1', 'T2', 'T3'], ['T5', 'T6'], ['T7']]),
    );
    expect(cycles).toHaveLength(3);
  });

  it('finds a cycle in a long chain without running out of stack', () => {
    const n = 20_000;
    const tasks = Array.from({ length: n }, (_, i) =>
      task(`T${i + 1}`, { dependsOn: [`T${((i + 1) % n) + 1}`] }),
    );
    expect(findCycles(tasks)).toHaveLength(1);
  });
});

describe('readiness is pure', () => {
  it('does not change its input and gives the same answer twice', () => {
    const input: ReadinessInput = {
      tasks: [
        task('T1', { topic: 'P1', block: 'K1' }),
        task('T2', { topic: 'P1', block: 'K2', dependsOn: ['T1', 'T9'] }),
      ],
      topics: [topic('P1', 'K1', 'K2')],
      readIssues: [unreadableTask('T7')],
      statuses: STATUSES,
    };
    const before = structuredClone(input);
    const first = readiness(input);
    expect(input).toEqual(before);
    expect(readiness(input)).toEqual(first);
  });
});

describe('launchState', () => {
  const blocked: BlockingReason[] = [{ code: 'task-not-done', task: 'T1' }];

  it('✓ for a done task, and nothing else', () => {
    expect(launchState({ status: 'done' }, [])).toEqual({
      done: true,
      running: false,
      blocked: false,
      launchable: false,
    });
  });

  it('✓ and not 🔒 for a done task that has reasons', () => {
    expect(launchState({ status: 'done' }, blocked)).toEqual({
      done: true,
      running: false,
      blocked: false,
      launchable: false,
    });
  });

  it('▷ for a task without reasons and without a run', () => {
    expect(launchState({ status: 'todo' }, [])).toEqual({
      done: false,
      running: false,
      blocked: false,
      launchable: true,
    });
  });

  it('🔒 for a task with reasons', () => {
    expect(launchState({ status: 'todo' }, blocked)).toEqual({
      done: false,
      running: false,
      blocked: true,
      launchable: false,
    });
  });

  it('● and 🔒 together for a running task with reasons', () => {
    const state = launchState(
      { status: 'in-progress', aiRun: { agent: 'a', state: 'working' } },
      blocked,
    );
    expect(state).toEqual({ done: false, running: true, blocked: true, launchable: false });
  });

  it('● for a running task without reasons, which may not be started again', () => {
    const state = launchState(
      { status: 'in-progress', aiRun: { agent: 'a', state: 'working' } },
      [],
    );
    expect(state).toEqual({ done: false, running: true, blocked: false, launchable: false });
  });

  it.each(['finished', 'failed', 'needs-review'] as const)(
    'a run that is %s is not running',
    (state) => {
      expect(launchState({ status: 'todo', aiRun: { agent: 'a', state } }, [])).toEqual({
        done: false,
        running: false,
        blocked: false,
        launchable: true,
      });
    },
  );
});

/** A small seeded generator: the project has no property-based library, and needs none for this. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBoard(seed: number): ReadinessInput {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const n = 1 + Math.floor(next() * 10);
  const ids = Array.from({ length: n + 2 }, (_, i) => `T${i + 1}`); // the last two never exist
  const topics = [topic('P1', 'K1', 'K2', 'K3'), topic('P2', 'K4', 'K5')];
  const tasks = ids.slice(0, n).map((id) => {
    const placed = pick([undefined, ...topics]);
    const dependsOn = ids.filter(() => next() < 0.25);
    return task(id, {
      status: pick(STATUSES),
      ...(placed && { topic: placed.id }),
      ...(placed && next() < 0.7 && { block: pick(placed.blocks).id }),
      ...(dependsOn.length > 0 && { dependsOn }),
    });
  });
  const readIssues = next() < 0.2 ? [unreadableTask(ids[n]!)] : [];
  return { tasks, topics, readIssues, statuses: STATUSES };
}

/** Whether `from` reaches itself through the dependencies: the definition of being in a cycle. */
function inCycle(from: string, tasks: readonly ReadinessTask[]): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const stack = [...(byId.get(from)?.dependsOn ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    stack.push(...(byId.get(id)!.dependsOn ?? []));
  }
  return false;
}

describe('readiness: properties over random boards', () => {
  const seeds = Array.from({ length: 2000 }, (_, i) => i + 1);

  it('a dependency that is not done keeps a task from being ready', () => {
    for (const seed of seeds) {
      const input = randomBoard(seed);
      const result = readiness(input);
      const byId = new Map(input.tasks.map((t) => [t.id, t]));
      for (const t of input.tasks) {
        for (const dep of t.dependsOn ?? []) {
          const target = byId.get(dep);
          if (target === undefined || target.status === 'done') continue;
          expect({ seed, task: t.id, reasons: result[t.id] }).toEqual({
            seed,
            task: t.id,
            reasons: expect.arrayContaining([{ code: 'task-not-done', task: dep }]),
          });
          expect(launchState(t, result[t.id]!).launchable).toBe(false);
        }
      }
    }
  });

  it('every task of a cycle is blocked by it, and no other task is', () => {
    for (const seed of seeds) {
      const input = randomBoard(seed);
      const result = readiness(input);
      for (const t of input.tasks) {
        expect({ seed, task: t.id, cycle: codes(result[t.id]).includes('cycle') }).toEqual({
          seed,
          task: t.id,
          cycle: inCycle(t.id, input.tasks),
        });
      }
    }
  });

  it('gives every task of the board an answer', () => {
    for (const seed of seeds.slice(0, 200)) {
      const input = randomBoard(seed);
      expect(Object.keys(readiness(input)).sort()).toEqual(input.tasks.map((t) => t.id).sort());
    }
  });
});
