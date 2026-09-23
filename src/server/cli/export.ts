import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSnapshot } from '../../core/index.js';
import { createStorage } from '../storage/index.js';
import { boardFacts, type ResolvedBoard } from './board.js';

/**
 * `.board/` is untracked, so a snapshot is the only backup of a board (ADR-0009, §12).
 * Export reads through the storage port and writes nothing to the board, so it is safe
 * while the board is running.
 */
export async function exportBoard(
  board: ResolvedBoard,
  options: { out?: string | undefined; write: (text: string) => void },
): Promise<void> {
  const storage = createStorage(board.config, { root: board.root });
  await storage.init();
  try {
    const snapshot = await createSnapshot(storage, boardFacts(board.config));
    const json = JSON.stringify(snapshot, null, 2);
    if (options.out === undefined) {
      options.write(json);
      return;
    }
    const file = resolve(board.root, options.out);
    await writeFile(file, `${json}\n`, 'utf8');
    options.write(
      `Exported ${snapshot.tasks.length} tasks, ${snapshot.documents.length} documents ` +
        `and ${snapshot.reports.length} reports to ${file}`,
    );
  } finally {
    await storage.close();
  }
}
