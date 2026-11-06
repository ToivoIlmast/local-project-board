import { LAUNCH_MESSAGE_MAX_LENGTH, type LaunchFailureKind } from '../../core/model/launch.js';
import { findRunningBoard, post } from './running.js';

/**
 * A start of a work run that stopped before the board recorded a run (ADR-0029 T94, K9). Its
 * `message` is what the terminal shows, as before; `report` is what the board may be told:
 * fixed words of the runner, or the fixed text of a board answer, never anything else (K10).
 */
export class NotBegun extends Error {
  override readonly name = 'NotBegun';

  constructor(
    readonly kind: LaunchFailureKind,
    message: string,
    readonly report: string,
  ) {
    super(message);
  }
}

/** What the board is told of any failure the runner has no fixed words for (K10). */
export const RUNNER_ERROR_REPORT = 'The runner could not start Claude Code; see its terminal.';

/** Anything thrown before a successful begin, as a `NotBegun`; the terminal keeps its text. */
export function notBegun(error: unknown): NotBegun {
  if (error instanceof NotBegun) return error;
  return new NotBegun(
    'runner-error',
    error instanceof Error ? error.message : String(error),
    RUNNER_ERROR_REPORT,
  );
}

export type RunFailureDelivery = 'delivered' | 'stale' | 'refused' | 'undelivered';

const TRIES = 3;
const PAUSE_MS = 500;

/**
 * Tells the board that the work run of a request did not begin (K9): up to three tries, 500 ms
 * apart, on no answer or a 5xx, looking for the board afresh before each, as an end is (T45): a
 * board restarted on the same `.board/` still holds the request. Any other answer ends it; a 409
 * says a run has begun since, or another request came. No journal: this runner is alive and says
 * in its terminal what it could not deliver.
 */
export async function reportRunFailure(
  root: string,
  taskId: string,
  requestId: string,
  failure: NotBegun,
): Promise<RunFailureDelivery> {
  const body = {
    requestId,
    kind: failure.kind,
    message: failure.report.slice(0, LAUNCH_MESSAGE_MAX_LENGTH),
  };
  for (let attempt = 1; attempt <= TRIES; attempt += 1) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    const board = await findRunningBoard(root);
    if (board === undefined) continue;
    const answer = await post(board, `/tasks/${taskId}/run-failure`, body);
    if (answer === undefined || answer.status >= 500) continue;
    if (answer.ok) return 'delivered';
    return answer.status === 409 ? 'stale' : 'refused';
  }
  return 'undelivered';
}
