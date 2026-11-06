import type { Task } from '../model/task.js';
import { idNumber } from './ids.js';
import { isBlockDone, type ReadinessInput, type ReadinessTask } from './readiness.js';
import { compareByRank } from './rank.js';
import { DONE_STATUS, isDone, isKnownStatus } from './status.js';

export type RevalidationTask = ReadinessTask & Pick<Task, 'rank' | 'doneAt' | 'aiRun'>;

export interface RevalidationInput extends Omit<ReadinessInput, 'tasks'> {
  tasks: readonly RevalidationTask[];
}

/** Why a task is in the scope; the first of these that applies to it. */
export type ScopeBasis = 'dependent' | 'block' | 'next-block';
/** Why a task in the scope is not checked: it is done, or an AI run is working on it. */
export type ScopeExclusion = 'done' | 'ai-running';

export interface ScopeItem {
  task: string;
  basis: ScopeBasis;
  excluded?: ScopeExclusion;
}

const TASK_FILE = /^tasks\/[^/]+\/task\.md$/;

/**
 * The task that finished block `block` of `topic`, if there is one: the block is done now (the
 * predicate of readiness, `isBlockDone`) and the task has the greatest key `(doneAt, number of
 * the id, prefix of the id)` in it; a task without `doneAt` comes before all that have one. So
 * there is at most one, whatever the order of the tasks.
 *
 * Fail-closed (C-2): a task.md that cannot be read could belong to any block, so with one on the
 * board no block is known to be done, and nobody finished it. Computed from the board as it is
 * now and never stored, so the answer returns on its own when the file can be read again.
 */
export function finishingTask(
  input: RevalidationInput,
  topic: string,
  block: string,
): string | undefined {
  if (!isKnownStatus(DONE_STATUS, input.statuses)) return undefined;
  if (input.readIssues.some((issue) => TASK_FILE.test(issue.file))) return undefined;
  if (!blockKnown(input, topic, block)) return undefined;
  const members = input.tasks.filter((task) => task.topic === topic && task.block === block);
  if (!isBlockDone(members)) return undefined;
  return members.reduce((latest, task) => (compareFinish(task, latest) > 0 ? task : latest)).id;
}

/**
 * What a completed task asks to check again (ADR-0032, M1 §2.5), in this order: the tasks that
 * depend on it directly, the not done tasks of its block, and, if it finished the block, the not
 * done tasks of the next block. Only direct dependencies count, a blocked task is in, and a task
 * with several grounds is in once, at the first. By rank within a ground. A task that is done or
 * has an AI run working is kept in the list with the reason it is not checked, `done` first.
 * Without a topic or a block (or when the board does not know them) only the dependents remain.
 * Pure: nothing is kept, so nothing has to be undone.
 */
export function revalidationScope(input: RevalidationInput, id: string): ScopeItem[] {
  const subject = input.tasks.find((task) => task.id === id);
  if (subject === undefined) return [];

  const grounds: [ScopeBasis, RevalidationTask[]][] = [
    ['dependent', input.tasks.filter((task) => task.dependsOn?.includes(id))],
    ['block', openTasksOf(input, subject.topic, subject.block)],
  ];
  const next = nextBlock(input, subject);
  if (next !== undefined && finishingTask(input, next.topic, next.after) === id) {
    grounds.push(['next-block', openTasksOf(input, next.topic, next.block)]);
  }

  const scope = new Map<string, ScopeItem>();
  for (const [basis, tasks] of grounds) {
    for (const task of [...tasks].sort(compareByRank)) {
      if (task.id === id || scope.has(task.id)) continue;
      const excluded = exclusionOf(task);
      scope.set(
        task.id,
        excluded === undefined ? { task: task.id, basis } : { task: task.id, basis, excluded },
      );
    }
  }
  return [...scope.values()];
}

function exclusionOf(task: RevalidationTask): ScopeExclusion | undefined {
  if (isDone(task)) return 'done';
  return task.aiRun?.state === 'working' ? 'ai-running' : undefined;
}

function openTasksOf(
  input: RevalidationInput,
  topic: string | undefined,
  block: string | undefined,
): RevalidationTask[] {
  if (topic === undefined || block === undefined || !blockKnown(input, topic, block)) return [];
  return input.tasks.filter(
    (task) => task.topic === topic && task.block === block && !isDone(task),
  );
}

/** The topic can be read and holds the block: otherwise the board cannot place anything in it. */
function blockKnown(input: RevalidationInput, topic: string, block: string): boolean {
  if (input.readIssues.some((issue) => issue.file === `topics/${topic}/topic.md`)) return false;
  return (
    input.topics.find((known) => known.id === topic)?.blocks.some((known) => known.id === block) ??
    false
  );
}

/** The block after the one `task` is in, in its topic; none if the board does not know either. */
function nextBlock(
  input: RevalidationInput,
  task: RevalidationTask,
): { topic: string; after: string; block: string } | undefined {
  if (task.topic === undefined || task.block === undefined) return undefined;
  const blocks = input.topics.find((topic) => topic.id === task.topic)?.blocks;
  const at = blocks?.findIndex((block) => block.id === task.block) ?? -1;
  const following = at === -1 ? undefined : blocks?.[at + 1];
  return following === undefined
    ? undefined
    : { topic: task.topic, after: task.block, block: following.id };
}

/** Positive when `a` finished later than `b`: `doneAt` as a moment, then the id number, then its prefix. */
function compareFinish(a: RevalidationTask, b: RevalidationTask): number {
  return (
    compare(moment(a), moment(b)) ||
    compare(numberOf(a.id), numberOf(b.id)) ||
    compare(prefixOf(a.id), prefixOf(b.id))
  );
}

function moment(task: RevalidationTask): number {
  return task.doneAt === undefined ? -Infinity : Date.parse(task.doneAt);
}

function prefixOf(id: string): string {
  return /^[A-Z]+/.exec(id)?.[0] ?? id;
}

function numberOf(id: string): number {
  return idNumber(prefixOf(id), id) ?? 0;
}

function compare<T extends number | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
