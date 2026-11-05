import {
  launchState,
  readiness,
  type BlockingReason,
  type Task,
  type Topic,
} from '../../../../contract/v1/index';
import { ApiError } from '../../../api/index';
import { reasonText } from './readinessText';

/** The board as the page holds it: what readiness is computed from. */
export interface BoardData {
  tasks: readonly Task[];
  topics: readonly Topic[];
  readIssues: readonly { file: string }[];
  statuses: readonly string[];
}

export type Block = Topic['blocks'][number];

/** The blocks a task of this topic may be in, in the order of the topic. */
export function blockOptions(topics: readonly Topic[], topic: string | undefined): Block[] {
  return topics.find((candidate) => candidate.id === topic)?.blocks ?? [];
}

/** "P1 · Alpha / K1 · Design": where a task is, in the words the page uses for a topic and a block. */
export function placeLabel(
  topics: readonly Topic[],
  topic: string | undefined,
  block: string | undefined,
): string {
  if (topic === undefined) return 'no topic';
  const held = topics.find((candidate) => candidate.id === topic);
  const where = held === undefined ? `${topic} (not on the board)` : `${topic} · ${held.title}`;
  if (block === undefined) return `${where} / no block`;
  const inside = held?.blocks.find((candidate) => candidate.id === block);
  return `${where} / ${inside === undefined ? block : `${block} · ${inside.title}`}`;
}

/**
 * Whether changing the status of this task by hand has to be confirmed (ADR-0032 §8): it is
 * blocked, and the status really changes. Staying in the column is a reorder, not a change.
 */
export function needsStatusConfirmation(
  task: Pick<Task, 'status' | 'aiRun'>,
  reasons: readonly BlockingReason[],
  next: string,
): boolean {
  return next !== task.status && launchState(task, reasons).blocked;
}

export interface BlockSummary {
  done: number;
  total: number;
  /** One of the three, or none for a block that is under way and held by nothing. */
  state: 'completed' | 'waiting' | 'empty' | undefined;
}

/** The reasons that are an earlier block holding this one (ADR-0032 §5). */
const ORDER_REASONS: ReadonlySet<BlockingReason['code']> = new Set([
  'block-incomplete',
  'block-empty',
  'block-order-unknown',
]);

/**
 * Done/total of a block and its state, from the tasks in it and the reasons the board gave them.
 * Never more than one state: a block without tasks is empty whatever is before it, and a block
 * whose tasks are all done is completed.
 */
export function blockSummary(
  tasks: readonly Task[],
  reasons: Readonly<Record<string, readonly BlockingReason[]>>,
): BlockSummary {
  const done = tasks.filter((task) => launchState(task, []).done).length;
  const total = tasks.length;
  if (total === 0) return { done, total, state: 'empty' };
  if (done === total) return { done, total, state: 'completed' };
  const waiting = tasks.some(
    (task) =>
      !launchState(task, []).done &&
      (reasons[task.id] ?? []).some((reason) => ORDER_REASONS.has(reason.code)),
  );
  return { done, total, state: waiting ? 'waiting' : undefined };
}

export interface MoveDescription {
  from: string;
  to: string;
  /** What readiness says now, and after the move, in words. */
  before: string[];
  after: string[];
  /** What the move does to the order of blocks, one sentence each. */
  blocks: string[];
}

type BlockState = 'empty' | 'done' | 'open';

function stateOf(tasks: readonly Task[]): BlockState {
  if (tasks.length === 0) return 'empty';
  return tasks.every((task) => launchState(task, []).done) ? 'done' : 'open';
}

/**
 * What moving a task to another topic or block would change, or nothing when it stays where it
 * is. Readiness is worked out by the function the board uses, over the board as it would be; the
 * order of blocks from which blocks are empty or done before and after. The page asks nothing of
 * the board for this and changes nothing (ADR-0032 §8).
 */
export function describeMove(
  data: BoardData,
  id: string,
  to: { topic?: string | undefined; block?: string | undefined },
): MoveDescription | undefined {
  const task = data.tasks.find((candidate) => candidate.id === id);
  if (task === undefined) return undefined;
  if (task.topic === to.topic && task.block === to.block) return undefined;

  const { topic: _topic, block: _block, ...rest } = task;
  const moved: Task = {
    ...rest,
    ...(to.topic === undefined ? {} : { topic: to.topic }),
    ...(to.block === undefined ? {} : { block: to.block }),
  };
  const after = data.tasks.map((candidate) => (candidate.id === id ? moved : candidate));
  const reasonsOf = (tasks: readonly Task[]): string[] =>
    (readiness({ ...data, tasks })[id] ?? []).map(reasonText);

  return {
    from: placeLabel(data.topics, task.topic, task.block),
    to: placeLabel(data.topics, to.topic, to.block),
    before: reasonsOf(data.tasks),
    after: reasonsOf(after),
    blocks: [...changes(data, after, task, to), destination(data.topics, to)],
  };
}

/** The blocks of the two topics whose state — empty, done, open — the move changes. */
function changes(
  data: BoardData,
  after: readonly Task[],
  task: Task,
  to: { topic?: string | undefined },
): string[] {
  const topics = [...new Set([task.topic, to.topic])].flatMap((id) => {
    const topic = data.topics.find((candidate) => candidate.id === id);
    return topic === undefined ? [] : [topic];
  });
  const lines: string[] = [];
  for (const topic of topics) {
    topic.blocks.forEach((block, index) => {
      const within = (tasks: readonly Task[]) =>
        tasks.filter((candidate) => candidate.topic === topic.id && candidate.block === block.id);
      const was = stateOf(within(data.tasks));
      const now = stateOf(within(after));
      if (was === now) return;
      const later = topic.blocks.slice(index + 1).map((candidate) => candidate.id);
      lines.push(transition(block.id, was, now, later));
    });
  }
  return lines;
}

function transition(block: string, was: BlockState, now: BlockState, later: string[]): string {
  const behind = later.join(', ');
  if (now === 'empty') {
    return `${block} has no tasks left: it becomes empty${behind === '' ? '' : `, and ${behind} wait for it`}.`;
  }
  if (now === 'open') {
    if (was === 'done') {
      return `${block} is no longer done${behind === '' ? '' : `: ${behind} wait for it again`}.`;
    }
    return `${block} gets its first task${behind === '' ? '' : `: ${behind} wait for it`}.`;
  }
  return `${block} becomes done${behind === '' ? '' : `: ${behind} no longer wait for it`}.`;
}

/** Where the task lands in the order of blocks. */
function destination(
  topics: readonly Topic[],
  to: { topic?: string | undefined; block?: string | undefined },
): string {
  const topic = topics.find((candidate) => candidate.id === to.topic);
  if (to.topic === undefined || to.block === undefined || topic === undefined) {
    return to.topic === undefined
      ? 'The task is outside the order of blocks: it waits for no block.'
      : `The task is in ${to.topic} without a block: outside the order of blocks.`;
  }
  const index = topic.blocks.findIndex((candidate) => candidate.id === to.block);
  if (index === -1) return `${to.block} is not a block of ${topic.id}.`;
  if (index === 0)
    return `${to.block} is the first block of ${topic.id}: the task waits for no block.`;
  const earlier = topic.blocks.slice(0, index).map((candidate) => candidate.id);
  return `${to.block} comes after ${earlier.join(', ')} in ${topic.id}: the task waits until they are done.`;
}

/** The fields of a task that place it, and what the board refused in each. */
export type PlacementField = 'topic' | 'block' | 'dependsOn';
export type FieldErrors = Partial<Record<PlacementField, string>>;

/**
 * Which field a refusal of the board is about, in the board's own words: a block that is not the
 * topic's, or needs one, is the Block's; any other place is the Topic's; a task that does not
 * exist or would make a cycle is Depends on's. Anything else is not about these fields.
 */
export function placementRefusal(error: unknown): FieldErrors | undefined {
  if (!(error instanceof ApiError)) return undefined;
  switch (error.code) {
    case 'INVALID_PLACEMENT':
      return error.details['block'] === undefined
        ? { topic: error.message }
        : { block: error.message };
    case 'INVALID_DEPENDENCY':
    case 'DEPENDENCY_CYCLE':
      return { dependsOn: error.message };
    default:
      return undefined;
  }
}

/** "T1, T2" or "T1 T2" as the ids it names, each once, in the order typed. */
export function parseDependsOn(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter((id) => id !== ''))];
}

/** What a form holds of the three, in the form the API takes them; empty is not set. */
export interface PlacementValues {
  topic?: string | undefined;
  block?: string | undefined;
  dependsOn: string[];
}

/**
 * The change of the three that the form asks for, against the task: only what differs, and
 * `null` where it is to be cleared. A topic that goes takes its block with it.
 */
export function placementPatch(
  task: Pick<Task, 'topic' | 'block' | 'dependsOn'>,
  values: PlacementValues,
): { topic?: string | null; block?: string | null; dependsOn?: string[] | null } {
  const patch: { topic?: string | null; block?: string | null; dependsOn?: string[] | null } = {};
  if (values.topic !== task.topic) patch.topic = values.topic ?? null;
  if (values.block !== task.block) patch.block = values.block ?? null;
  const before = task.dependsOn ?? [];
  if (
    values.dependsOn.length !== before.length ||
    values.dependsOn.some((id, index) => id !== before[index])
  ) {
    patch.dependsOn = values.dependsOn.length === 0 ? null : values.dependsOn;
  }
  return patch;
}
