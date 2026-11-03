import { BoardError } from '../errors.js';
import type { Task } from '../model/task.js';
import type { Block, Topic } from '../model/topic.js';

/**
 * What a topic holds that keeps it from being deleted: its blocks, empty ones included, and the
 * tasks in it. A task is in a topic by its `topic`, or by a `block` of it (a hand-edited board
 * may hold one without the other). `unreadable` names task files that could not be read: they
 * may be tasks of the topic, and a delete that cannot rule it out does not happen (ADR-0032 §4).
 */
export interface TopicContents {
  blocks: string[];
  tasks: string[];
  unreadable: string[];
}

export function topicContents(
  topic: Topic,
  tasks: readonly Task[],
  unreadable: readonly string[] = [],
): TopicContents {
  const blocks = topic.blocks.map((block) => block.id);
  return {
    blocks,
    tasks: tasks
      .filter(
        (task) =>
          task.topic === topic.id || (task.block !== undefined && blocks.includes(task.block)),
      )
      .map((task) => task.id),
    unreadable: [...unreadable],
  };
}

/** Refuses with `TOPIC_NOT_EMPTY` unless the topic has no blocks, no tasks and nothing unread. */
export function assertTopicDeletable(
  topic: Topic,
  tasks: readonly Task[],
  unreadable: readonly string[] = [],
): void {
  const held = topicContents(topic, tasks, unreadable);
  if (held.blocks.length + held.tasks.length + held.unreadable.length === 0) return;
  throw new BoardError(
    'TOPIC_NOT_EMPTY',
    `Topic "${topic.id}" is not empty and cannot be deleted: ${describe(held)}. ` +
      'Delete its empty blocks and move or delete its tasks first.',
    { id: topic.id, ...held },
  );
}

/** Refuses with `BLOCK_NOT_EMPTY` while a task is in the block. */
export function assertBlockDeletable(
  topic: Topic,
  blockId: string,
  tasks: readonly Task[],
  unreadable: readonly string[] = [],
): void {
  const inBlock = tasks.filter((task) => task.block === blockId).map((task) => task.id);
  if (inBlock.length + unreadable.length === 0) return;
  throw new BoardError(
    'BLOCK_NOT_EMPTY',
    `Block "${blockId}" of topic "${topic.id}" is not empty and cannot be deleted: ` +
      `${describe({ tasks: inBlock, unreadable })}. Move or delete its tasks first.`,
    { topic: topic.id, block: blockId, tasks: inBlock, unreadable: [...unreadable] },
  );
}

/** The block of that topic, or `BLOCK_NOT_FOUND`: a block of another topic is not found here. */
export function requireBlock(topic: Topic, blockId: string): Block {
  const block = topic.blocks.find((candidate) => candidate.id === blockId);
  if (!block) {
    throw new BoardError(
      'BLOCK_NOT_FOUND',
      `Block "${blockId}" is not a block of topic "${topic.id}".`,
      { topic: topic.id, block: blockId },
    );
  }
  return block;
}

/** The blocks of the topic in the order given, or `INVALID_REQUEST` if it is not every one once. */
export function reorderedBlocks(topic: Topic, order: readonly string[]): Block[] {
  const held = new Map(topic.blocks.map((block) => [block.id, block]));
  const whole = order.length === held.size && new Set(order).size === order.length;
  const blocks = whole ? order.map((id) => held.get(id)) : [];
  if (!whole || blocks.some((block) => block === undefined)) {
    throw new BoardError(
      'INVALID_REQUEST',
      `The order must name every block of topic "${topic.id}" exactly once ` +
        `(${[...held.keys()].join(', ') || 'it has none'}).`,
      { topic: topic.id, blocks: [...held.keys()], order: [...order] },
    );
  }
  return blocks as Block[];
}

function describe(held: { [K in keyof TopicContents]?: readonly string[] }): string {
  const parts: string[] = [];
  if (held.blocks?.length) parts.push(`blocks ${held.blocks.join(', ')}`);
  if (held.tasks?.length) parts.push(`tasks ${held.tasks.join(', ')}`);
  if (held.unreadable?.length)
    parts.push(`task files that cannot be read ${held.unreadable.join(', ')}`);
  return parts.join('; ');
}
