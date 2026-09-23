import { API_BASE_PATH, generateInstructions } from '../../contract/v1/index.js';
import { boardFacts, type ResolvedBoard } from './board.js';
import { isBoardAlive, readRuntime } from './runtime.js';

/**
 * The instructions an agent needs, from the board itself when it is running — then they carry
 * the live URL and this run's token — and generated from the configuration when it is not.
 * There is one generator and one text; a stopped board simply knows no token (§16).
 */
export async function printInstructions(
  board: ResolvedBoard,
  write: (text: string) => void,
): Promise<void> {
  const running = await runningBoard(board.root);
  if (running !== undefined) {
    write(running.trimEnd());
    return;
  }
  write(
    generateInstructions({
      baseUrl: `http://127.0.0.1:${board.config.server.port}`,
      board: boardFacts(board.config),
    }).trimEnd(),
  );
}

/** What a running board answers, or nothing at all: a file alone is not a running board. */
async function runningBoard(root: string): Promise<string | undefined> {
  const runtime = await readRuntime(root);
  // A damaged runtime file is no reason to refuse: reading instructions changes nothing.
  if (runtime.kind !== 'state') return undefined;
  if (!(await isBoardAlive(runtime.state))) return undefined;
  try {
    const response = await fetch(`${runtime.state.url}${API_BASE_PATH.slice(1)}/instructions`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok ? await response.text() : undefined;
  } catch {
    return undefined;
  }
}
