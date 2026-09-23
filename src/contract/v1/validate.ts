import type { z } from 'zod';
import type { Route } from './routes.js';

export interface ValidationIssue {
  /** Dotted field path, '' for the value itself. */
  path: string;
  message: string;
}

export type ParseResult<T> = { ok: true; data: T } | { ok: false; issues: ValidationIssue[] };

/**
 * Requests are validated with the very schemas the contract publishes, so the API cannot
 * accept something the contract does not describe.
 */
export function parseBody(route: Route, value: unknown): ParseResult<unknown> {
  if (!route.request) {
    return value === undefined || value === null || isEmptyObject(value)
      ? { ok: true, data: undefined }
      : fail('This endpoint takes no request body.');
  }
  return parse(route.request, value);
}

export function parseParams(route: Route, value: unknown): ParseResult<unknown> {
  return route.params ? parse(route.params, value) : { ok: true, data: {} };
}

export function parseQuery(route: Route, value: unknown): ParseResult<unknown> {
  return route.query ? parse(route.query, value) : { ok: true, data: {} };
}

function parse(schema: z.ZodType, value: unknown): ParseResult<unknown> {
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, data: result.data }
    : {
        ok: false,
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      };
}

function fail(message: string): ParseResult<never> {
  return { ok: false, issues: [{ path: '', message }] };
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.keys(value).length === 0;
}
