/** Stable error codes. The HTTP layer maps them to status codes; clients may rely on them. */
export type BoardErrorCode =
  | 'UNKNOWN_STATUS'
  | 'ORPHANED_STATUSES'
  | 'INVALID_ID_PREFIX'
  | 'INVALID_ID_SEQUENCE'
  | 'TASK_NOT_FOUND'
  | 'DOCUMENT_NOT_FOUND'
  | 'REPORT_NOT_FOUND'
  | 'INVALID_DOCUMENT_NAME'
  | 'NEIGHBOR_NOT_FOUND'
  | 'INVALID_POSITION';

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
