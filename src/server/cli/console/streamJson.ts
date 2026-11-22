import { StringDecoder } from 'node:string_decoder';

/**
 * NDJSON input and output of Claude Code's stream-json protocol (Console mode, T17).
 * Pure functions: no process, no normalization.
 */

export interface LineSplitter {
  /** Feeds a chunk of bytes; returns the lines it completed (without `\n` or `\r\n`). */
  push(chunk: Buffer): string[];
  /** Ends the stream; returns the held tail without a newline, if any. Safe to call twice. */
  end(): string[];
}

/**
 * Splits a byte stream into lines. Bytes are decoded with a StringDecoder, so a character cut
 * between two chunks is held until it is whole. A trailing `\r` is dropped (CRLF); empty lines
 * are kept; the tail without `\n` is held until `end()`.
 */
export function createLineSplitter(): LineSplitter {
  const decoder = new StringDecoder('utf8');
  let tail = '';

  const take = (text: string): string[] => {
    const parts = (tail + text).split('\n');
    tail = parts.pop() ?? '';
    return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  };

  return {
    push: (chunk) => take(decoder.write(chunk)),
    end: () => {
      const rest = tail + decoder.end();
      tail = '';
      if (rest === '') return [];
      return [rest.endsWith('\r') ? rest.slice(0, -1) : rest];
    },
  };
}

export type ParseLineResult =
  { ok: true; message: Record<string, unknown> } | { ok: false; error: string };

/** Parses one line as a JSON object. Never throws. */
export function parseLine(line: string): ParseLineResult {
  if (line.trim() === '') return { ok: false, error: 'empty line' };
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'not a JSON object' };
  }
  return { ok: true, message: value as Record<string, unknown> };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one line to write to Claude's stdin for a user message: `JSON.stringify` + `\n`.
 * Throws when the uuid is missing or not a UUID, or the text is not a string or holds NUL.
 * JSON.stringify escapes every control character, U+2028/2029 stay inside a JSON string and
 * lone surrogates become `\udXXX`, so the result is exactly one line.
 */
export function serializeUserMessage(input: { uuid: string; text: string }): string {
  const { uuid, text } = input;
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) {
    throw new Error('serializeUserMessage: uuid is required and must be a UUID');
  }
  if (typeof text !== 'string') {
    throw new Error('serializeUserMessage: text must be a string');
  }
  if (text.includes('\u0000')) {
    throw new Error('serializeUserMessage: text must not contain NUL');
  }
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, uuid })}\n`;
}
