import type { Task } from '../model/task.js';
import type { Topic } from '../model/topic.js';
import { DONE_STATUS, isDone, isKnownStatus } from './status.js';

/** Why a task may not be started yet: a code and what it is about, never words (ADR-0032 §5). */
export type BlockingReason =
  | { code: 'task-not-done'; task: string }
  | { code: 'task-missing'; task: string }
  | { code: 'task-unreadable'; task: string }
  | { code: 'topic-missing'; topic: string }
  | { code: 'topic-unreadable'; topic: string }
  | { code: 'block-missing'; topic: string; block: string }
  /** `tasks`: those of the block that are not done. */
  | { code: 'block-incomplete'; topic: string; block: string; tasks: string[] }
  | { code: 'block-empty'; topic: string; block: string }
  /** `tasks`: the tasks whose task.md cannot be read, so whose block is not known. */
  | { code: 'block-order-unknown'; tasks: string[] }
  /** `tasks`: every task of the cycle, in the order of the board's tasks. */
  | { code: 'cycle'; tasks: string[] }
  /** `status`: the status the board needs and has not got configured. */
  | { code: 'config'; status: string };

export type BlockingReasonCode = BlockingReason['code'];

export type ReadinessTask = Pick<Task, 'id' | 'status' | 'topic' | 'block' | 'dependsOn'>;
export type ReadinessTopic = Pick<Topic, 'id'> & { blocks: readonly { id: string }[] };

/** What readiness is computed from: the board as it is read now, and nothing kept. */
export interface ReadinessInput {
  /** The tasks that could be read. */
  tasks: readonly ReadinessTask[];
  /** The topics that could be read. */
  topics: readonly ReadinessTopic[];
  /** The files that could not be read, as `Storage.readIssues` reports them. */
  readIssues: readonly { file: string }[];
  statuses: readonly string[];
}

const TASK_FILE = /^tasks\/([^/]+)\/task\.md$/;
const TOPIC_FILE = /^topics\/([^/]+)\/topic\.md$/;

/**
 * The reasons of every task in `input.tasks`, by id; a task that may start has none. Computed
 * from the board as it is now and never stored, so a reason goes once its cause is gone.
 *
 * Only direct dependencies count; a task that merely depends on a cycle is not in it. A block
 * waits for every block before it in its topic. Without a `done` status nothing can be told done,
 * so a task that would have to wait for one gets `config` instead, and the rest of the board
 * keeps its reasons. An unreadable task.md could belong to any block, so with one on the board
 * no task of a block that has blocks before it can start (fail-closed).
 */
export function readiness(input: ReadinessInput): Record<string, BlockingReason[]> {
  const doneKnown = isKnownStatus(DONE_STATUS, input.statuses);
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  const topics = new Map(input.topics.map((topic) => [topic.id, topic]));
  const unreadableTasks = idsOf(input.readIssues, TASK_FILE).filter((id) => !tasks.has(id));
  const unreadableTopics = new Set(idsOf(input.readIssues, TOPIC_FILE));

  const byBlock = new Map<string, ReadinessTask[]>();
  for (const task of input.tasks) {
    if (task.topic === undefined || task.block === undefined) continue;
    const key = blockKey(task.topic, task.block);
    byBlock.set(key, [...(byBlock.get(key) ?? []), task]);
  }
  const cycleOf = new Map<string, string[]>();
  for (const members of findCycles(input.tasks)) {
    for (const id of members) cycleOf.set(id, members);
  }

  const result: Record<string, BlockingReason[]> = {};
  for (const task of input.tasks) {
    const placement: BlockingReason[] = [];
    let earlier: readonly { id: string }[] = [];
    if (task.topic !== undefined) {
      const topic = topics.get(task.topic);
      if (unreadableTopics.has(task.topic)) {
        placement.push({ code: 'topic-unreadable', topic: task.topic });
      } else if (topic === undefined) {
        placement.push({ code: 'topic-missing', topic: task.topic });
      } else if (task.block !== undefined) {
        const at = topic.blocks.findIndex((block) => block.id === task.block);
        if (at === -1)
          placement.push({ code: 'block-missing', topic: topic.id, block: task.block });
        else earlier = topic.blocks.slice(0, at);
      }
    }
    const dependsOn = [...new Set(task.dependsOn ?? [])];

    const reasons: BlockingReason[] = [];
    if (!doneKnown && (dependsOn.length > 0 || earlier.length > 0)) {
      reasons.push({ code: 'config', status: DONE_STATUS });
    }
    reasons.push(...placement);
    if (earlier.length > 0 && unreadableTasks.length > 0) {
      reasons.push({ code: 'block-order-unknown', tasks: unreadableTasks });
    }
    for (const block of earlier) {
      const members = byBlock.get(blockKey(task.topic!, block.id)) ?? [];
      const open = members.filter((member) => !isDone(member)).map((member) => member.id);
      if (members.length === 0) {
        reasons.push({ code: 'block-empty', topic: task.topic!, block: block.id });
      } else if (doneKnown && open.length > 0) {
        reasons.push({
          code: 'block-incomplete',
          topic: task.topic!,
          block: block.id,
          tasks: open,
        });
      }
    }
    for (const id of dependsOn) {
      const dependency = tasks.get(id);
      if (dependency !== undefined) {
        if (doneKnown && !isDone(dependency)) reasons.push({ code: 'task-not-done', task: id });
      } else if (unreadableTasks.includes(id)) {
        reasons.push({ code: 'task-unreadable', task: id });
      } else {
        reasons.push({ code: 'task-missing', task: id });
      }
    }
    const cycle = cycleOf.get(task.id);
    if (cycle !== undefined) reasons.push({ code: 'cycle', tasks: cycle });
    result[task.id] = reasons;
  }
  return result;
}

/**
 * The cycles of the direct dependencies: each strongly connected group of more than one task, or
 * a task that depends on itself, with its tasks in the order given. A dependency on a task that is
 * not given leads nowhere. Iterative (Tarjan), so a long chain does not run out of stack.
 */
export function findCycles(tasks: readonly Pick<Task, 'id' | 'dependsOn'>[]): string[][] {
  const order = new Map(tasks.map((task, at) => [task.id, at]));
  const edges = new Map(
    tasks.map((task) => [task.id, (task.dependsOn ?? []).filter((id) => order.has(id))]),
  );
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const enter = (id: string) => {
    index.set(id, index.size);
    low.set(id, index.get(id)!);
    stack.push(id);
    onStack.add(id);
  };

  for (const { id: root } of tasks) {
    if (index.has(root)) continue;
    enter(root);
    const path = [{ id: root, next: 0 }];
    while (path.length > 0) {
      const frame = path[path.length - 1]!;
      const out = edges.get(frame.id)!;
      if (frame.next < out.length) {
        const to = out[frame.next++]!;
        if (!index.has(to)) {
          enter(to);
          path.push({ id: to, next: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(to)!));
        }
        continue;
      }
      path.pop();
      const parent = path[path.length - 1];
      if (parent !== undefined) {
        low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      }
      if (low.get(frame.id) !== index.get(frame.id)) continue;
      const members: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        members.push(member);
      } while (member !== frame.id);
      if (members.length > 1 || out.includes(frame.id)) {
        cycles.push(members.sort((a, b) => order.get(a)! - order.get(b)!));
      }
    }
  }
  return cycles;
}

/**
 * What can be done with a task now, as marks the page draws: ✓ done, ● an AI run is working,
 * 🔒 it has reasons, ▷ it may be started. ● and 🔒 can go together; a done task is only ✓ (and
 * ●, should a run still be working on it); a task that is running may not be started again.
 */
export interface LaunchState {
  done: boolean;
  running: boolean;
  blocked: boolean;
  launchable: boolean;
}

export function launchState(
  task: Pick<Task, 'status' | 'aiRun'>,
  reasons: readonly BlockingReason[],
): LaunchState {
  const done = isDone(task);
  const running = task.aiRun?.state === 'working';
  return {
    done,
    running,
    blocked: !done && reasons.length > 0,
    launchable: !done && !running && reasons.length === 0,
  };
}

function idsOf(issues: readonly { file: string }[], file: RegExp): string[] {
  const ids = issues.flatMap((issue) => file.exec(issue.file)?.[1] ?? []);
  return [...new Set(ids)];
}

function blockKey(topic: string, block: string): string {
  return `${topic}/${block}`;
}
