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

// Control strings: OSC (`ESC ]`, 0x9d), DCS (`ESC P`, 0x90), SOS (`ESC X`, 0x98), PM (`ESC ^`,
// 0x9e), APC (`ESC _`, 0x9f). A string ends with BEL or ST (`ESC \` or 0x9c). An unfinished one
// ends at the next ESC or at the line break, so the text after it is not lost.
const STRING_BODY = '[^\\u0007\\u001b\\u009c\\n]*';
const STRING_END = '(?:\\u0007|\\u009c|\\u001b\\\\)?';
const STRINGS = new RegExp(
  `(?:\\u001b[\\]P_^X]|[\\u009d\\u0090\\u0098\\u009e\\u009f])${STRING_BODY}${STRING_END}`,
  'g',
);
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const ESC_OTHER = /\u001b[ -/]*[0-~]/g;
// C0 except \n and \t, DEL, C1.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

const stripEscapes = (input: string) =>
  input.replace(STRINGS, '').replace(CSI, '').replace(ESC_OTHER, '');

/** Default limit of one `runner.stderr` event (contract: 4 KB). */
export const STDERR_MAX = 4096;

/**
 * Makes a piece of stderr safe to store and to show: removes ANSI CSI and control strings (OSC,
 * DCS, APC, PM, SOS, in 7-bit and 8-bit forms; hyperlinks keep their text, window titles go), BEL,
 * C0 except `\n` and `\t`, and C1; keeps the last state of a `\r` redraw of each line; replaces
 * lone surrogates; truncates at a character boundary.
 */
export function sanitizeStderr(input: string, max: number = STDERR_MAX): string {
  const stripped = stripEscapes(input);
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
      return truncateText(oneLine(value), SUMMARY_MAX);
    }
  }
  return '';
}

/** Escapes removed, every control, line break and run of spaces is one space, trimmed. */
function oneLine(text: string): string {
  return fixSurrogates(
    stripEscapes(text)
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/**
 * Text of a tool result for display: escapes and controls removed (`\n` and `\t` stay), `\r\n`
 * and `\r` are `\n`, runs of empty lines shrink to one, lone surrogates are replaced. Not cut:
 * the caller applies its limit.
 */
export function sanitizePreview(text: string): string {
  return fixSurrogates(
    stripEscapes(text)
      .replace(/\r\n?/g, '\n')
      .replace(CONTROLS, '')
      .replace(/\n{3,}/g, '\n\n'),
  );
}
