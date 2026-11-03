import { BoardError } from '../errors.js';
import type { Topic } from '../model/topic.js';
import { idNumber, isBlockId, isTaskId, isTopicId } from './ids.js';

/** What of a task's place a write brings: only what it names is checked. */
export interface PlacementWrite {
  topic?: string | null | undefined;
  block?: string | null | undefined;
  dependsOn?: string[] | null | undefined;
}

/** The place a task ends up in, with the fields a write leaves alone taken from the task. */
export interface Placement {
  topic?: string | undefined;
  block?: string | undefined;
}

/**
 * Refuses, with `INVALID_REQUEST`, a place that is not whole: a block without a topic, or a block
 * the topic does not hold, and a `dependsOn` that is not in the form of the task ids of the board.
 * Checked by the provider on the way in, because it holds the topics; whether the tasks named in
 * `dependsOn` exist, and whether they make a cycle, is not decided here (ADR-0032 §3–4).
 *
 * A write that names neither `topic` nor `block` leaves them unchecked, and so does one without
 * `dependsOn`: a board of an earlier version may hold a place that is not whole, and a task that
 * is only renamed must stay writable.
 */
export async function assertPlacement(
  write: PlacementWrite,
  current: Placement,
  idPrefix: string,
  getTopic: (id: string) => Promise<Topic | null>,
): Promise<void> {
  if (write.dependsOn) {
    const bad = write.dependsOn.find((id) => !isTaskId(id) || idNumber(idPrefix, id) === null);
    if (bad !== undefined) {
      throw new BoardError(
        'INVALID_REQUEST',
        `"${bad}" in dependsOn is not a task id of this board (prefix "${idPrefix}").`,
        { dependsOn: bad, idPrefix },
      );
    }
  }
  if (write.topic === undefined && write.block === undefined) return;

  const topic = write.topic === undefined ? current.topic : (write.topic ?? undefined);
  const block = write.block === undefined ? current.block : (write.block ?? undefined);
  if (block === undefined) return;
  if (topic === undefined) {
    throw new BoardError('INVALID_REQUEST', `Block "${block}" needs a topic.`, { block });
  }
  const held =
    isTopicId(topic) && isBlockId(block)
      ? (await getTopic(topic))?.blocks.some((candidate) => candidate.id === block)
      : false;
  if (!held) {
    throw new BoardError(
      'INVALID_REQUEST',
      `Block "${block}" does not belong to topic "${topic}".`,
      {
        topic,
        block,
      },
    );
  }
}
