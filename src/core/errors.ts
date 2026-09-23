/** Stable error codes. The HTTP layer maps them to status codes; clients may rely on them. */
export type BoardErrorCode =
  | 'UNKNOWN_STATUS'
  | 'INVALID_ID_PREFIX'
  | 'INVALID_ID_SEQUENCE'
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
