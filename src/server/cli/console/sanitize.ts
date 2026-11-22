/* eslint-disable no-control-regex -- terminal control characters are the subject of this file */

/**
 * Text hygiene of Console mode (plan C4): stderr of the process, and the limits of the texts of
 * events. Pure functions.
 */

/** Cuts `text` to at most `max` UTF-16 units without splitting a surrogate pair. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  // A high surrogate at the cut: its low half would be dropped, so drop the high half too.
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** Replaces a lone surrogate by U+FFFD; whole pairs stay. */
function fixSurrogates(text: string): string {
  return text.replace(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    '�',
  );
}

// Strings (OSC, DCS, APC, PM, SOS) end with BEL or ST; an unfinished one ends at the next ESC.
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const OSC_C1 = /\u009d[^\u0007\u009c]*(?:\u0007|\u009c)?/g;
const STRINGS = /\u001b[P_^X][^\u001b]*(?:\u001b\\)?/g;
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const ESC_OTHER = /\u001b[ -/]*[0-~]/g;
// C0 except \n and \t, DEL, C1.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Default limit of one `runner.stderr` event (contract: 4 KB). */
export const STDERR_MAX = 4096;

/**
 * Makes a piece of stderr safe to store and to show: removes ANSI CSI and OSC (hyperlinks keep
 * their text, window titles go), BEL, C0 except `\n` and `\t`, and C1; keeps the last state of a
 * `\r` redraw of each line; replaces lone surrogates; truncates at a character boundary.
 */
export function sanitizeStderr(input: string, max: number = STDERR_MAX): string {
  const stripped = input
    .replace(OSC, '')
    .replace(OSC_C1, '')
    .replace(STRINGS, '')
    .replace(CSI, '')
    .replace(ESC_OTHER, '');
  const lines = stripped.replace(/\r\n/g, '\n').split('\n');
  const redrawn = lines.map((line) => {
    if (!line.includes('\r')) return line;
    const parts = line.split('\r').filter((part) => part !== '');
    return parts[parts.length - 1] ?? '';
  });
  return truncateText(fixSurrogates(redrawn.join('\n').replace(CONTROLS, '')), max);
}

const SUMMARY_KEYS = [
  'command',
  'file_path',
  'path',
  'notebook_path',
  'url',
  'pattern',
  'query',
  'description',
] as const;

/** Max length of the summary of a tool call (contract: 300). */
export const SUMMARY_MAX = 300;

/**
 * One short line for a tool call: the command, or the path, of its input (at most 300 characters).
 * `tool` is not used to choose the field yet: the first known field present wins, so a new tool
 * with a `command` or `file_path` input needs no change here.
 */
export function summarizeToolInput(_tool: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return truncateText(fixSurrogates(value.replace(/\0/g, '')), SUMMARY_MAX);
    }
  }
  return '';
}
