import { generateInstructions } from '../../contract/v1/index.js';
import { boardFacts, type ResolvedBoard } from './board.js';
import { askRunningBoard } from './running.js';

/**
 * The instructions an agent needs, from the board itself when it is running — then they carry
 * the live URL and this run's token — and generated from the configuration when it is not.
 * There is one generator and one text; a stopped board simply knows no token (§16).
 */
export async function printInstructions(
  board: ResolvedBoard,
  write: (text: string) => void,
): Promise<void> {
  const running = await askRunningBoard(board.root, '/instructions');
  if (running?.ok) {
    write((await running.text()).trimEnd());
    return;
  }
  write(
    generateInstructions({
      baseUrl: `http://127.0.0.1:${board.config.server.port}`,
      board: boardFacts(board.config),
      projectRules: board.config.ai.rules,
    }).trimEnd(),
  );
}
