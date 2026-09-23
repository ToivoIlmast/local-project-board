import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { HttpError } from './errors.js';

/**
 * The board listens on the loopback interface, which every page in the browser can also
 * reach. So the transport answers three questions before any route runs: is this request
 * addressed to us (Host), does it come from our own page or from no page at all (Origin),
 * and, if it changes something, does it carry this session's token (ADR-0008).
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1']);
const READ_METHODS = new Set(['GET', 'HEAD']);

/** JSON is data: it may do nothing, frame nothing and be framed by nothing. */
export const API_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** The board's own page: only what the board itself serves, and it frames only reports. */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * HTML written by an agent. It may run its own scripts — reports are interactive — but
 * `sandbox` without `allow-same-origin` puts it in an origin of its own, so it cannot read
 * the board's page, its storage or its token, and `'none'` everywhere else keeps it offline.
 */
export const EMBEDDED_HTML_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

/** 256 bits from the system CSPRNG, new for every run of the server. */
export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface HostOriginGuardOptions {
  /** The port the server is bound to; the Host header must name it. */
  port?: number | undefined;
}

/** Refuses a request addressed to any other name than this very board (DNS rebinding). */
export function createHostOriginGuard({ port }: HostOriginGuardOptions = {}): RequestHandler {
  return (request, _response, next) => {
    const host = splitHost(request.headers.host);
    if (!host || !LOOPBACK_HOSTNAMES.has(host.hostname)) throw forbiddenHost();
    if (port !== undefined && host.port !== String(port)) throw forbiddenHost();

    const origin = request.headers.origin;
    if (origin !== undefined && !isOwnOrigin(origin, host.port)) {
      throw new HttpError(403, 'FORBIDDEN_ORIGIN', 'This page may not talk to the board.');
    }
    next();
  };
}

/** Requires the session token for everything that changes the board. */
export function createTokenGuard(token: string): RequestHandler {
  return (request, _response, next) => {
    if (READ_METHODS.has(request.method) || matchesToken(request.headers.authorization, token)) {
      next();
      return;
    }
    throw new HttpError(401, 'UNAUTHORIZED', 'This request must carry the session token.');
  };
}

export function securityHeaders(policy: string): RequestHandler {
  return (_request, response, next) => {
    response.setHeader('Content-Security-Policy', policy);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };
}

function forbiddenHost(): HttpError {
  return new HttpError(403, 'FORBIDDEN_HOST', 'This request is addressed to another host.');
}

/** Deliberately without IPv6: the server binds 127.0.0.1, so `[::1]` is someone else. */
function splitHost(header: string | undefined): { hostname: string; port: string } | null {
  const match = /^([^:/\\]+)(?::(\d{1,5}))?$/.exec(header ?? '');
  return match?.[1] === undefined
    ? null
    : { hostname: match[1].toLowerCase(), port: match[2] ?? '' };
}

function isOwnOrigin(origin: string, port: string): boolean {
  let url: URL;
  try {
    // "null" — a sandboxed frame or a local file — is not a URL, and is not us either.
    url = new URL(origin);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase()) &&
    url.port === port
  );
}

function matchesToken(header: string | undefined, token: string): boolean {
  // The scheme is case-insensitive (RFC 7235); the credential is compared byte by byte.
  const given = /^bearer[ \t]+(.+)$/i.exec(header ?? '')?.[1];
  if (given === undefined) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
