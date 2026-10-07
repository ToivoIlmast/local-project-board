import { isTaskId } from '../../core/rules/ids.js';
import { API_BASE_PATH } from './routes.js';

/** The board answers on the loopback interface, on a port, and nowhere else (ADR-0008). */
const BOARD_ADDRESS = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/;

/**
 * What Claude Code is told when it is started on a task: where the live handoff is, not the
 * handoff. The agent reads it itself, so the text is never stale, never has to fit a command
 * line and never has to be quoted (T19). There is no token in it: the handoff says how to ask
 * the board for one.
 *
 * The CLI is the only user: `claude <ID>` and the runner of `claude --wait`, which Send to AI
 * in the page reaches through the board (T27). The id and the address are checked all the
 * same, so that nothing but a task id and the loopback board ever gets into a command line.
 */
export function claudeCodePrompt(taskId: string, boardUrl: string): string {
  checked(taskId, boardUrl);
  return (
    `Work on task ${taskId} of the local board: ` +
    `read GET ${boardUrl}${API_BASE_PATH}/tasks/${taskId}/handoff and follow it.`
  );
}

/**
 * What a resumed session is told (T36): the same address, to be read again, because the handoff
 * of a resumed run says what to keep. No token, and checked the same way as the first prompt.
 */
export function continuationPrompt(taskId: string, boardUrl: string): string {
  checked(taskId, boardUrl);
  return (
    `Continue task ${taskId} of the local board: ` +
    `re-read GET ${boardUrl}${API_BASE_PATH}/tasks/${taskId}/handoff and follow it.`
  );
}

function checked(taskId: string, boardUrl: string): void {
  if (!isTaskId(taskId)) throw new Error(`"${taskId}" is not a task id.`);
  if (!BOARD_ADDRESS.test(boardUrl)) {
    throw new Error(`"${boardUrl}" is not a board address: http://127.0.0.1:<port> is expected.`);
  }
}
