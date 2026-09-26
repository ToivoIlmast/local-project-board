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
 * Both the command that the page copies and the launcher of the CLI use this one function. The
 * id and the address are checked, because the text is put inside double quotes of a shell.
 */
export function claudeCodePrompt(taskId: string, boardUrl: string): string {
  if (!isTaskId(taskId)) throw new Error(`"${taskId}" is not a task id.`);
  if (!BOARD_ADDRESS.test(boardUrl)) {
    throw new Error(`"${boardUrl}" is not a board address: http://127.0.0.1:<port> is expected.`);
  }
  return (
    `Work on task ${taskId} of the local board: ` +
    `read GET ${boardUrl}${API_BASE_PATH}/tasks/${taskId}/handoff and follow it.`
  );
}

/** The line to paste into a terminal in the project: `claude` with that prompt. */
export function claudeCodeCommand(taskId: string, boardUrl: string): string {
  return `claude "${claudeCodePrompt(taskId, boardUrl)}"`;
}
