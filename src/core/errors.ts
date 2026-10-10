/** Stable error codes. The HTTP layer maps them to status codes; clients may rely on them. */
export const BOARD_ERROR_CODES = [
  'UNKNOWN_STATUS',
  'ORPHANED_STATUSES',
  'INVALID_ID_PREFIX',
  'INVALID_ID_SEQUENCE',
  'TASK_NOT_FOUND',
  'DOCUMENT_NOT_FOUND',
  'REPORT_NOT_FOUND',
  'INVALID_DOCUMENT_NAME',
  'NEIGHBOR_NOT_FOUND',
  'INVALID_POSITION',
  'INVALID_GIT_ARGUMENT',
  /** Runner called end with a runId that is not the current one (T31). */
  'STALE_AI_RUN',
  /** Runner called begin when the task already has state: working (T31). */
  'AI_RUN_IN_PROGRESS',
  /** Agent sent a report when the run already has a final state (T32). */
  'AI_RUN_ALREADY_FINAL',
  /** Resume was asked for a task whose last run has no session to continue (T36). */
  'NO_SESSION_TO_RESUME',
] as const;

export type BoardErrorCode = (typeof BOARD_ERROR_CODES)[number];

export class BoardError extends Error {
  override readonly name = 'BoardError';

  constructor(
    readonly code: BoardErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
