import type { ErrorRequestHandler } from 'express';
import type { ErrorCode, ErrorResponse, ValidationIssue } from '../../contract/v1/index.js';
import { BoardError, type BoardErrorCode } from '../../core/errors.js';

/**
 * One status per domain error code (§13). 4xx tells the client what to change; a domain
 * error is never a stack trace and never a 500.
 */
const STATUS_BY_DOMAIN_CODE: Record<BoardErrorCode, number> = {
  TASK_NOT_FOUND: 404,
  DOCUMENT_NOT_FOUND: 404,
  REPORT_NOT_FOUND: 404,
  UNKNOWN_STATUS: 422,
  INVALID_DOCUMENT_NAME: 422,
  NEIGHBOR_NOT_FOUND: 422,
  INVALID_POSITION: 422,
  INVALID_GIT_ARGUMENT: 422,
  INVALID_ID_PREFIX: 422,
  ORPHANED_STATUSES: 409,
  INVALID_ID_SEQUENCE: 500,
};

/** An error the transport itself raises; the domain raises BoardError instead. */
export class HttpError extends Error {
  override readonly name = 'HttpError';

  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function invalidRequest(issues: ValidationIssue[]): HttpError {
  return new HttpError(400, 'INVALID_REQUEST', 'The request does not match the API contract.', {
    issues,
  });
}

export function describeError(error: unknown): { status: number; body: ErrorResponse } {
  if (error instanceof HttpError) {
    return answer(error.status, error.code, error.message, error.details);
  }
  if (error instanceof BoardError) {
    return answer(STATUS_BY_DOMAIN_CODE[error.code], error.code, error.message, error.details);
  }
  if (error instanceof URIError) {
    return answer(400, 'INVALID_REQUEST', 'The URL could not be decoded.');
  }
  switch (bodyParserType(error)) {
    case 'entity.parse.failed':
      return answer(400, 'INVALID_JSON', 'The request body is not valid JSON.');
    case 'entity.too.large':
      return answer(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
    default:
      // Nothing of the failure reaches the client: a message may name a file or a person.
      return answer(500, 'INTERNAL_ERROR', 'The board could not answer this request.');
  }
}

/** Errors are the last thing in the chain, so nothing can answer after them. */
export function errorHandler(onInternalError: (error: unknown) => void): ErrorRequestHandler {
  return (error, _request, response, next) => {
    const { status, body } = describeError(error);
    if (status >= 500) onInternalError(error);
    if (response.headersSent) {
      next(error);
      return;
    }
    response.status(status).json(body);
  };
}

function answer(
  status: number,
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): { status: number; body: ErrorResponse } {
  return { status, body: { error: { code, message, details } } };
}

function bodyParserType(error: unknown): string | undefined {
  const type = (error as { type?: unknown } | null)?.type;
  return typeof type === 'string' ? type : undefined;
}
