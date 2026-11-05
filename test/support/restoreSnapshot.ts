import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boardSnapshotSchema } from '../../src/core/model/index.js';
import { serializeTask } from '../../src/server/storage/markdown/taskFile.js';
import { serializeTopic } from '../../src/server/storage/markdown/topicFile.js';

/**
 * Test only: writes the tasks, the topics with their blocks and the counters of an export into a
 * board directory, as the Markdown provider keeps them. There is no import in the product
 * (ADR-0009, ADR-0032 §10); this stands in for one so a test can read a backup back.
 *
 * It repairs nothing: the export is parsed by the schema the product exports with, so a snapshot
 * that does not hold (a v3 one, a dangling reference, a bad counter) throws. The counters are
 * written as exported, and `sequence: null` writes no `sequence.json`, as the board had none.
 * The task counter, documents, reports and history are not restored.
 */
export async function restoreSnapshot(root: string, exported: unknown): Promise<void> {
  const snapshot = boardSnapshotSchema.parse(exported);
  if (snapshot.formatVersion !== 4) {
    throw new Error(`Only a formatVersion 4 export holds topics, not ${snapshot.formatVersion}.`);
  }
  const board = join(root, '.board');
  for (const task of snapshot.tasks) {
    await mkdir(join(board, 'tasks', task.id), { recursive: true });
    await writeFile(join(board, 'tasks', task.id, 'task.md'), serializeTask(task), 'utf8');
  }
  await mkdir(join(board, 'topics'), { recursive: true });
  for (const topic of snapshot.topics) {
    await mkdir(join(board, 'topics', topic.id), { recursive: true });
    await writeFile(join(board, 'topics', topic.id, 'topic.md'), serializeTopic(topic), 'utf8');
  }
  if (snapshot.sequence !== null) {
    await writeFile(
      join(board, 'topics', 'sequence.json'),
      `${JSON.stringify({ formatVersion: 1, ...snapshot.sequence }, null, 2)}\n`,
      'utf8',
    );
  }
}
