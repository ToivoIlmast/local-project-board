import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createLineSplitter,
  parseLine,
  serializeUserMessage,
} from '../../../src/server/cli/console/streamJson.js';

const UUID = '582f1010-5785-4d21-82ee-8de0412b6992';
const fixtures = join(process.cwd(), 'test', 'fixtures', 'claude-stream-json', '2.1.330');

function splitBytes(bytes: Buffer, size: number): string[] {
  const splitter = createLineSplitter();
  const out: string[] = [];
  for (let at = 0; at < bytes.length; at += size) {
    out.push(...splitter.push(bytes.subarray(at, at + size)));
  }
  out.push(...splitter.end());
  return out;
}

describe('createLineSplitter', () => {
  it('splits a line torn in the middle, at any chunk length', () => {
    const text = 'one\ntwo two\n\nthree';
    for (let size = 1; size <= text.length; size++) {
      expect(splitBytes(Buffer.from(text), size)).toEqual(['one', 'two two', '', 'three']);
    }
  });

  it('holds a tail without a newline until the end of the stream', () => {
    const s = createLineSplitter();
    expect(s.push(Buffer.from('{"a":1}\n{"b"'))).toEqual(['{"a":1}']);
    expect(s.push(Buffer.from(':2}'))).toEqual([]);
    expect(s.end()).toEqual(['{"b":2}']);
    expect(s.end()).toEqual([]);
  });

  it('does not invent an empty last line after a final newline', () => {
    expect(splitBytes(Buffer.from('a\nb\n'), 100)).toEqual(['a', 'b']);
  });

  it('tolerates CRLF and keeps empty lines', () => {
    expect(splitBytes(Buffer.from('a\r\n\r\nb\r\n'), 1)).toEqual(['a', '', 'b']);
    expect(splitBytes(Buffer.from('a\n\n\nb'), 2)).toEqual(['a', '', '', 'b']);
  });

  it.each(['я', '€', '😀'])(
    'does not corrupt %s cut between any two bytes of the byte stream',
    (ch) => {
      const bytes = Buffer.from(`x${ch}y\n${ch}${ch}\n${ch}`);
      const expected = [`x${ch}y`, `${ch}${ch}`, ch];
      const lines = splitBytes(bytes, 1);
      expect(lines).toEqual(expected);
      expect(lines.join('')).not.toContain('�');
      for (let cut = 1; cut < bytes.length; cut++) {
        const s = createLineSplitter();
        const got = [...s.push(bytes.subarray(0, cut)), ...s.push(bytes.subarray(cut)), ...s.end()];
        expect(got).toEqual(expected);
      }
    },
  );
});

describe('parseLine', () => {
  it('reads a JSON object', () => {
    expect(parseLine('{"type":"system"}')).toEqual({ ok: true, message: { type: 'system' } });
  });

  it('reports bad JSON, empty lines and non-objects without throwing', () => {
    for (const line of ['this is not json', '', '   ', '[1]', '42', 'null', '"s"']) {
      const r = parseLine(line);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });
});

describe('serializeUserMessage', () => {
  function roundTrip(text: string): unknown {
    const line = serializeUserMessage({ uuid: UUID, text });
    expect(line.endsWith('\n')).toBe(true);
    const body = line.slice(0, -1);
    // U+2028/2029 stay raw inside the JSON string: they are not line ends for an NDJSON reader.
    expect(body).not.toMatch(/[\n\r]/);
    expect(line.split('\n')).toHaveLength(2);
    return JSON.parse(body);
  }

  it('writes the user message shape with the uuid', () => {
    expect(roundTrip('hi')).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hi' },
      uuid: UUID,
    });
  });

  it('keeps newlines, quotes, backslashes, separators and C0 controls on one line', () => {
    let c0 = '';
    for (let i = 1; i < 0x20; i++) c0 += String.fromCharCode(i);
    const text = `a\nb\r\nc\td "q" \\ \\n \u2028 \u2029 ${c0} \u007f`;
    expect(roundTrip(text)).toMatchObject({ message: { content: text } });
  });

  it('round-trips a surrogate pair', () => {
    expect(roundTrip('😀 ok')).toMatchObject({ message: { content: '😀 ok' } });
  });

  it('escapes a lone surrogate into one valid JSON line', () => {
    const line = serializeUserMessage({ uuid: UUID, text: 'a\ud83db' });
    expect(line).toContain('\\ud83d');
    expect(line.split('\n')).toHaveLength(2);
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it('refuses text with NUL', () => {
    expect(() => serializeUserMessage({ uuid: UUID, text: 'a\u0000b' })).toThrow(/NUL/);
  });

  it('refuses a missing or non-UUID uuid', () => {
    expect(() => serializeUserMessage({ text: 'x' } as never)).toThrow(/uuid/i);
    expect(() => serializeUserMessage({ uuid: undefined, text: 'x' } as never)).toThrow(/uuid/i);
    for (const uuid of ['not-a-uuid', '', ' ' + UUID, UUID + '\n', UUID.slice(1)]) {
      expect(() => serializeUserMessage({ uuid, text: 'x' })).toThrow(/uuid/i);
    }
  });

  it('refuses text that is not a string', () => {
    expect(() => serializeUserMessage({ uuid: UUID, text: 1 as never })).toThrow(/text/i);
  });
});

interface Recorded {
  __raw?: unknown;
  uuid?: string;
  message?: { content?: unknown };
}

describe('T16 stdin fixtures', () => {
  const files = readdirSync(fixtures).filter((f) => f.endsWith('.stdin.ndjson'));

  it('re-serializes every line with a valid uuid into the same structure', () => {
    expect(files.length).toBeGreaterThan(10);
    let checked = 0;
    let refused = 0;
    for (const file of files) {
      const splitter = createLineSplitter();
      const lines = [...splitter.push(readFileSync(join(fixtures, file))), ...splitter.end()];
      for (const line of lines.filter((l) => l !== '')) {
        const parsed = parseLine(line);
        if (!parsed.ok) throw new Error(`${file}: ${parsed.error}`);
        const m = parsed.message as Recorded;
        if (m.__raw !== undefined) continue; // bad-input: deliberately raw
        if (m.uuid === undefined) continue; // sent without a uuid on purpose
        const text = m.message?.content as string;
        if (m.uuid === 'not-a-uuid') {
          expect(() => serializeUserMessage({ uuid: m.uuid as string, text })).toThrow();
          refused++;
          continue;
        }
        expect(JSON.parse(serializeUserMessage({ uuid: m.uuid, text }))).toEqual(m);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(refused).toBe(1);
  });
});

describe('fixtures of claude 2.1.330: hygiene', () => {
  it('hold no local paths, e-mail addresses or signatures, and only redacted thinking', () => {
    for (const file of readdirSync(fixtures)) {
      if (!file.endsWith('.ndjson') && !file.endsWith('.json')) continue;
      const text = readFileSync(join(fixtures, file), 'utf8');
      const home = /[A-Z]:\\\\Users\\\\|\/Users\/|\/home\/|AppData/i.test(text);
      expect({ file, home }).toEqual({ file, home: false });
      const email = /[\w.+-]+@[\w-]+\.(com|org|net|io)\b/.test(text);
      expect({ file, email }).toEqual({ file, email: false });
      expect({ file, signature: text.includes('"signature"') }).toEqual({
        file,
        signature: false,
      });
      for (const line of text.split('\n')) {
        const r = parseLine(line);
        if (!r.ok) continue;
        const content = (r.message as Recorded).message?.content;
        for (const b of Array.isArray(content) ? content : []) {
          if (b?.type === 'thinking') expect(b.thinking).toBe('<redacted>');
        }
      }
    }
  });
});
