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
  /** Restart was asked for a task that has no earlier run to start over (T37). */
  'NO_RUN_TO_RESTART',
  /** PATCH aiRun: null on a run with a runId, in any state: its runId must not restart (T45). */
  'AI_RUN_NOT_CLEARABLE',
  /** A request that can only be judged against the state of the board (ADR-0030 §7). */
  'INVALID_REQUEST',
  /** A version of a task that has no such number (ADR-0030). */
  'VERSION_NOT_FOUND',
  /** An actuality check of a task that has no such number (ADR-0030). */
  'CHECK_NOT_FOUND',
  /** A decision or a `fromCheck` names a recommendation the report does not have. */
  'RECOMMENDATION_NOT_FOUND',
  /** `ifContentHash` is not the hash of the content the task has now (ADR-0030 §4). */
  'TASK_CONTENT_CHANGED',
  /** A report or an end for a check that already has one (ADR-0030 §6). */
  'CHECK_ALREADY_FINAL',
  /** A decision or `fromCheck` needs a check that has a report (ADR-0030 §2). */
  'CHECK_NOT_REPORTED',
  /** A report cannot be applied: the content moved on, or the recommendation is not accepted. */
  'STALE_CHECK',
  /** A check report that does not hold against the version it was made on (ADR-0030 §6). */
  'INVALID_CHECK_REPORT',
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
