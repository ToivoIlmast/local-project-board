import { errorResponseSchema, type ErrorCode } from '../../contract/v1/index';
import type { HttpResponse } from './http';

/** Board error codes, plus the two failures that happen before a board error can exist. */
export type ApiErrorCode = ErrorCode | 'NETWORK_ERROR' | 'MALFORMED_RESPONSE';

/**
 * Everything the UI is allowed to know about a failed request. The message is the board's
 * own where there is one: the server already writes for a human, and inventing a second
 * wording would make the same failure read differently in two places.
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    /** 0 when the request never reached the board. */
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** A failing answer from the board; anything that is not the contract's error shape is not one. */
export async function errorFromResponse(response: HttpResponse, what: string): Promise<ApiError> {
  const body = await readJson(response);
  const parsed = errorResponseSchema.safeParse(body);
  if (!parsed.success) return malformedResponse(response.status, what);
  const { code, message, details } = parsed.data.error;
  return new ApiError(response.status, code, message, details);
}

/** A body is data, not a promise the transport is trusted to keep: never let it throw. */
export async function readJson(response: HttpResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** The board answered, but not with anything the contract describes (ADR-0005). */
export function malformedResponse(status: number, what: string): ApiError {
  return new ApiError(
    status,
    'MALFORMED_RESPONSE',
    `The board answered ${what} with ${status} and something this page cannot read.`,
  );
}

/** No answer at all: the board was stopped, or the page outlived it. */
export function networkError(): ApiError {
  return new ApiError(
    0,
    'NETWORK_ERROR',
    'The board is not answering. It may have been stopped in the terminal it was started from.',
  );
}
