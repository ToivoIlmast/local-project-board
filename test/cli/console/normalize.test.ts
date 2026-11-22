import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { consoleEventSchema, type ConsoleEvent } from '../../../src/contract/v1/console.js';
import {
  initialNormalizerState,
  normalize,
  normalizeLine,
  type NormalizerState,
} from '../../../src/server/cli/console/normalize.js';
import {
  sanitizeStderr,
  summarizeToolInput,
  truncateText,
} from '../../../src/server/cli/console/sanitize.js';

const dir = join(process.cwd(), 'test', 'fixtures', 'claude-stream-json', '2.1.330');

const FIXTURES = [
  'api-error',
  'bad-input',
  'mid-turn-message',
  'multi-message',
  'parent-death',
  'parent-death-detached',
  'parent-death-detached-idle',
  'parent-death-idle',
  'permissions',
  'sigint',
  'sigterm',
  'stdin-close-mid-turn',
  'subagent',
  'tools',
  'tools-write-denied',
  'uuid-edge-cases',
];

interface Step {
  input: Record<string, unknown>;
  events: ConsoleEvent[];
  dropped: string | undefined;
}

function readMessages(name: string): Record<string, unknown>[] {
  return readFileSync(join(dir, `${name}.stdout.ndjson`), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function run(messages: Record<string, unknown>[]): { steps: Step[]; events: ConsoleEvent[] } {
  let state: NormalizerState = initialNormalizerState();
  const steps: Step[] = [];
  for (const input of messages) {
    const out = normalize(state, input);
    state = out.state;
    steps.push({ input, events: out.events, dropped: out.dropped });
  }
  return { steps, events: steps.flatMap((s) => s.events) };
}

const fixture = (name: string) => run(readMessages(name));
const ofKind = <K extends ConsoleEvent['kind']>(events: ConsoleEvent[], kind: K) =>
  events.filter((e): e is Extract<ConsoleEvent, { kind: K }> => e.kind === kind);

const U1 = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';

describe('fixtures of claude 2.1.330', () => {
  describe.each(FIXTURES)('%s', (name) => {
    const { steps, events } = fixture(name);

    it('normalizes without exceptions, and every event passes consoleEventSchema', () => {
      for (const event of events) {
        expect(consoleEventSchema.safeParse(event).success).toBe(true);
      }
    });

    it('shows no allowed rate limit and no thinking tokens', () => {
      expect(events.filter((e) => e.kind === 'notice' && e.code === 'rate_limit')).toEqual([]);
      expect(JSON.stringify(events)).not.toContain('thinking_tokens');
    });

    it('maps every input or lists it as dropped', () => {
      for (const step of steps) {
        if (step.events.length === 0) {
          expect(step.dropped).toEqual(expect.any(String));
        }
      }
    });

    it('never turns thinking into text', () => {
      const thinking = steps
        .filter((s) => JSON.stringify(s.input).includes('"type":"thinking"'))
        .flatMap((s) => s.events);
      expect(thinking.filter((e) => e.kind === 'assistant.text')).toEqual([]);
    });
  });

  it('multi-message: two turns, nine lifecycle events, three replays', () => {
    const { events } = fixture('multi-message');
    const turns = ofKind(events, 'turn.started');
    expect(turns).toHaveLength(2);
    expect(turns[0]?.userMessageIds).toHaveLength(1);
    expect(turns[1]?.userMessageIds).toHaveLength(2);
    expect(turns.map((t) => t.turn)).toEqual([1, 2]);
    const lifecycle = ofKind(events, 'user.lifecycle');
    expect(lifecycle).toHaveLength(9);
    for (const state of ['queued', 'started', 'completed']) {
      expect(lifecycle.filter((e) => e.state === state)).toHaveLength(3);
    }
    expect(ofKind(events, 'user.replayed')).toHaveLength(3);
    expect(ofKind(events, 'turn.ended').map((t) => t.turn)).toEqual([1, 2]);
  });

  it('mid-turn-message: started for M arrives inside an open turn, no turn.started between', () => {
    const { events } = fixture('mid-turn-message');
    const kinds = events.map((e) => e.kind);
    const turnStarts = kinds.filter((k) => k === 'turn.started');
    expect(turnStarts).toHaveLength(1);
    const startedIdx = events.flatMap((e, i) =>
      e.kind === 'user.lifecycle' && e.state === 'started' ? [i] : [],
    );
    const first = kinds.indexOf('turn.started');
    const end = kinds.indexOf('turn.ended');
    expect(startedIdx.length).toBe(2);
    const mid = startedIdx.find((i) => i > first);
    expect(mid).toBeDefined();
    expect(mid).toBeLessThan(end);
    expect(kinds.slice(first + 1, mid).includes('turn.started')).toBe(false);
  });

  it('subagent: Agent call, scoped events after turn.ended, jobs.background, empty second turn', () => {
    const { events } = fixture('subagent');
    const agent = ofKind(events, 'tool.call').find((e) => e.tool === 'Agent');
    expect(agent).toBeDefined();
    const firstEnd = events.findIndex((e) => e.kind === 'turn.ended');
    const scoped = events
      .map((e, i) => ({ e, i }))
      .filter(
        ({ e }) =>
          (e.kind === 'assistant.text' || e.kind === 'tool.call' || e.kind === 'tool.result') &&
          e.scope === agent?.toolUseId,
      );
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.some(({ i }) => i > firstEnd)).toBe(true);
    const background = ofKind(events, 'jobs.background').map((e) => e.jobIds);
    expect(background[0]).toHaveLength(1);
    expect(background[background.length - 1]).toEqual([]);
    const turns = ofKind(events, 'turn.started');
    expect(turns).toHaveLength(2);
    expect(turns[1]?.userMessageIds).toEqual([]);
  });

  it('tools: five call/result pairs, the last result is an error', () => {
    const { events } = fixture('tools');
    const calls = ofKind(events, 'tool.call');
    const results = ofKind(events, 'tool.result');
    expect(calls).toHaveLength(5);
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.toolUseId)).toEqual(calls.map((c) => c.toolUseId));
    expect(results[4]?.isError).toBe(true);
    expect(results.slice(0, 4).every((r) => !r.isError)).toBe(true);
  });

  it('subagent jobs: updated + ended once, then notified with a summary and no second ended', () => {
    const { events } = fixture('subagent');
    const jobs = events.filter((e) => e.kind.startsWith('job.') && e.kind !== 'job.progress');
    const kinds = jobs.map((e) => e.kind);
    const updated = kinds.indexOf('job.updated');
    expect(kinds.slice(updated, updated + 2)).toEqual(['job.updated', 'job.ended']);
    expect(kinds.filter((k) => k === 'job.ended')).toHaveLength(1);
    const notified = ofKind(events, 'job.notified');
    expect(notified).toHaveLength(1);
    expect(notified[0]?.status).toBe('completed');
    expect(notified[0]?.summary).toBe('subagent-content-42');
    expect(kinds.indexOf('job.notified')).toBeGreaterThan(kinds.indexOf('job.ended'));
  });

  it.each(['mid-turn-message', 'stdin-close-mid-turn'])(
    '%s: task_notification completed gives job.notified and one job.ended',
    (name) => {
      const { events } = fixture(name);
      expect(ofKind(events, 'job.notified').length).toBeGreaterThan(0);
      expect(ofKind(events, 'job.ended')).toHaveLength(1);
    },
  );

  it.each(['permissions', 'tools-write-denied'])(
    '%s: permission.denied carries tool and toolUseId',
    (name) => {
      const denied = ofKind(fixture(name).events, 'permission.denied');
      expect(denied.length).toBeGreaterThan(0);
      for (const d of denied) {
        expect(d.tool).toEqual(expect.any(String));
        expect(d.toolUseId).toEqual(expect.any(String));
      }
    },
  );

  it('api-error: turn ended with api_error, lifecycle cancelled', () => {
    const { events } = fixture('api-error');
    const ended = ofKind(events, 'turn.ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ isError: true, terminalReason: 'api_error' });
    expect(ofKind(events, 'user.lifecycle').some((e) => e.state === 'cancelled')).toBe(true);
  });

  it('uuid-edge-cases: duplicate replays, a single queued for the duplicate', () => {
    const { events } = fixture('uuid-edge-cases');
    const replayed = ofKind(events, 'user.replayed');
    const dup = replayed.filter(
      (e) => replayed.filter((o) => o.messageId === e.messageId).length > 1,
    );
    expect(dup).toHaveLength(2);
    const id = dup[0]?.messageId;
    expect(
      ofKind(events, 'user.lifecycle').filter((e) => e.messageId === id && e.state === 'queued'),
    ).toHaveLength(1);
    // "not-a-uuid" cannot pass the contract: dropped with one protocol_malformed per field
    const malformed = events.filter((e) => e.kind === 'notice' && e.code === 'protocol_malformed');
    expect(malformed.length).toBeGreaterThan(0);
    const keys = malformed.map((e) => JSON.stringify(e));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('job events (mutations)', () => {
  const update = (status?: string) => ({
    type: 'system',
    subtype: 'task_updated',
    task_id: 'j1',
    patch: status === undefined ? { end_time: 1 } : { status },
  });
  const notify = (status?: string) => ({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'j1',
    ...(status === undefined ? {} : { status }),
    summary: 'done',
  });

  it.each(['running', 'killed', 'weird-status'])('%s ends nothing', (status) => {
    const { events } = run([update(status), notify(status)]);
    expect(events.map((e) => e.kind)).toEqual(['job.updated', 'job.notified']);
  });

  it('task_updated without patch.status gives nothing', () => {
    expect(run([update()]).events).toEqual([]);
  });

  it('ends once, whichever message completes first', () => {
    const a = run([notify('completed'), update('completed')]).events.map((e) => e.kind);
    expect(a).toEqual(['job.notified', 'job.ended', 'job.updated']);
  });

  it('skips a repeated job.progress with the same description and lastTool', () => {
    const progress = (description: string, last?: string) => ({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'j1',
      description,
      ...(last === undefined ? {} : { last_tool_name: last }),
    });
    const { events } = run([
      progress('a', 'Read'),
      progress('a', 'Read'),
      progress('a', 'Grep'),
      progress('b', 'Grep'),
      { ...progress('a', 'Read'), task_id: 'j2' },
    ]);
    expect(ofKind(events, 'job.progress').map((e) => [e.jobId, e.description, e.lastTool])).toEqual(
      [
        ['j1', 'a', 'Read'],
        ['j1', 'a', 'Grep'],
        ['j1', 'b', 'Grep'],
        ['j2', 'a', 'Read'],
      ],
    );
  });
});

describe('synthetic cases', () => {
  it('an unknown type or subtype gives one protocol.unknown per pair', () => {
    const { events } = run([
      { type: 'mystery' },
      { type: 'mystery', x: 1 },
      { type: 'system', subtype: 'new_thing' },
      { type: 'system', subtype: 'new_thing' },
      { type: 'system', subtype: 'other_thing' },
    ]);
    expect(events).toEqual([
      { kind: 'protocol.unknown', type: 'mystery' },
      { kind: 'protocol.unknown', type: 'system', subtype: 'new_thing' },
      { kind: 'protocol.unknown', type: 'system', subtype: 'other_thing' },
    ]);
  });

  it('a result without is_error warns and still closes the turn', () => {
    const { events } = run([
      { type: 'system', subtype: 'init', session_id: SID },
      { type: 'result', subtype: 'success', terminal_reason: 'completed' },
    ]);
    const ended = ofKind(events, 'turn.ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ turn: 1, isError: false });
    expect(events).toContainEqual({
      kind: 'notice',
      level: 'warning',
      code: 'protocol_malformed',
      type: 'result',
      field: 'is_error',
    });
    for (const event of events) expect(consoleEventSchema.safeParse(event).success).toBe(true);
  });

  it('warns about one (type, field) once', () => {
    const bad = { type: 'result', subtype: 'success' };
    const { events } = run([bad, bad]);
    expect(events.filter((e) => e.kind === 'notice' && e.field === 'is_error')).toHaveLength(1);
    expect(ofKind(events, 'turn.ended')).toHaveLength(2);
  });

  it('shows a rate limit that is not allowed', () => {
    const { events } = run([
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'notice', level: 'warning', code: 'rate_limit' });
  });

  it('turns an api_retry into a notice', () => {
    const { events } = run([{ type: 'system', subtype: 'api_retry', attempt: 2 }]);
    expect(events[0]).toMatchObject({ kind: 'notice', level: 'warning', code: 'api_retry' });
  });

  it('writes model only when it changed', () => {
    const init = (model: string) => ({ type: 'system', subtype: 'init', model });
    const turns = ofKind(run([init('m1'), init('m1'), init('m2')]).events, 'turn.started');
    expect(turns.map((t) => t.model)).toEqual(['m1', undefined, 'm2']);
  });

  it('does not change the state it is given (pure)', () => {
    const state = initialNormalizerState();
    for (const message of [{ type: 'mystery' }, { type: 'system', subtype: 'init', model: 'm' }]) {
      expect(normalize(state, message).events).toEqual(normalize(state, message).events);
    }
  });

  it('truncates long texts inside the contract limits', () => {
    const { events } = run([
      {
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'text', text: 'x'.repeat(100_000) }] },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'y'.repeat(9999) }],
        },
      },
    ]);
    for (const event of events) expect(consoleEventSchema.safeParse(event).success).toBe(true);
    expect(events).toHaveLength(2);
  });

  it('reads an array tool_result and a message uuid', () => {
    const { events } = run([
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              is_error: true,
              content: [{ type: 'text', text: 'boom' }],
            },
          ],
        },
        parent_tool_use_id: 'toolu_p',
      },
      { type: 'user', isReplay: true, uuid: U1 },
    ]);
    expect(events).toEqual([
      { kind: 'tool.result', toolUseId: 't1', isError: true, preview: 'boom', scope: 'toolu_p' },
      { kind: 'user.replayed', messageId: U1 },
    ]);
  });
});

describe('invalid input', () => {
  it.each([
    ['a non-JSON line', 'not json at all'],
    ['a line without type', '{"a":1}'],
    ['an array', '[1,2]'],
    ['an empty line', ''],
  ])('%s gives protocol.unknown <invalid>', (_name, line) => {
    const out = normalizeLine(initialNormalizerState(), line);
    expect(out.events).toEqual([{ kind: 'protocol.unknown', type: '<invalid>' }]);
  });

  it('normalize accepts a non-object', () => {
    expect(normalize(initialNormalizerState(), 42).events).toEqual([
      { kind: 'protocol.unknown', type: '<invalid>' },
    ]);
    expect(normalize(initialNormalizerState(), { type: 5 }).events).toEqual([
      { kind: 'protocol.unknown', type: '<invalid>' },
    ]);
  });
});

describe('summarizeToolInput', () => {
  it('takes the command or the path', () => {
    expect(summarizeToolInput('Bash', { command: 'ls -la', description: 'x' })).toBe('ls -la');
    expect(summarizeToolInput('Read', { file_path: '/a/b.txt' })).toBe('/a/b.txt');
    expect(summarizeToolInput('Grep', { pattern: 'foo', path: 'src' })).toBe('src');
  });

  it('returns an empty string for nothing usable', () => {
    expect(summarizeToolInput('X', null)).toBe('');
    expect(summarizeToolInput('X', { n: 1 })).toBe('');
  });

  it('is at most 300 characters and does not split a surrogate pair', () => {
    const long = summarizeToolInput('Bash', { command: 'a'.repeat(299) + '😀' + 'b' });
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long).toBe('a'.repeat(299));
  });
});

describe('sanitizeStderr', () => {
  const ESC = '\u001b';
  it('removes CSI sequences', () => {
    expect(sanitizeStderr(`${ESC}[31mred${ESC}[0m ${ESC}[2K${ESC}[1;32mok`)).toBe('red ok');
  });

  it('removes OSC 8 hyperlinks and keeps the text', () => {
    const link = `${ESC}]8;;https://example.com${ESC}\\click${ESC}]8;;${ESC}\\`;
    expect(sanitizeStderr(`a ${link} b`)).toBe('a click b');
  });

  it('removes a window title (BEL and ST terminated)', () => {
    expect(sanitizeStderr(`${ESC}]0;title\u0007text`)).toBe('text');
    expect(sanitizeStderr(`${ESC}]2;title${ESC}\\text`)).toBe('text');
  });

  it('removes BEL, C0 except newline and tab, and C1', () => {
    expect(sanitizeStderr('a\u0007b\u0000c\u0008d\u007fe\u0080f\u0085g\nh\ti')).toBe(
      'abcdefg\nh\ti',
    );
  });

  it('removes 8-bit CSI sequences', () => {
    expect(sanitizeStderr('a\u009b31mb')).toBe('ab');
  });

  it('keeps the last state of a carriage-return redraw', () => {
    expect(sanitizeStderr('10%\r50%\r100%\ndone')).toBe('100%\ndone');
    expect(sanitizeStderr('line\r\nnext\r\n')).toBe('line\nnext\n');
    expect(sanitizeStderr('abc\r')).toBe('abc');
  });

  it('keeps surrogate pairs and replaces a lone one', () => {
    expect(sanitizeStderr('a😀b')).toBe('a😀b');
    expect(sanitizeStderr('a\ud83db')).toBe('a�b');
  });

  it('truncates at a character boundary', () => {
    const out = sanitizeStderr('😀'.repeat(10), 5);
    expect(out).toBe('😀😀');
    expect(truncateText('abc', 10)).toBe('abc');
    expect(truncateText('ab😀', 3)).toBe('ab');
  });

  it('is 4096 characters at most by default', () => {
    expect(sanitizeStderr('x'.repeat(10_000)).length).toBe(4096);
  });
});

describe('sanitizeStderr: unfinished and unusual control strings (D1)', () => {
  const ESC = '\u001b';

  it('an unfinished OSC ends at the line break; the next lines stay', () => {
    expect(sanitizeStderr(`${ESC}]0;title\nnext line\nthird`)).toBe('\nnext line\nthird');
  });

  it('APC, DCS, PM and SOS ended by BEL do not swallow the text after them', () => {
    expect(sanitizeStderr(`a${ESC}_payload\u0007b`)).toBe('ab');
    expect(sanitizeStderr(`a${ESC}Pq data\u0007b`)).toBe('ab');
    expect(sanitizeStderr(`a${ESC}^pm\u0007b${ESC}Xsos\u0007c`)).toBe('abc');
  });

  it('an unfinished APC or DCS ends at the line break', () => {
    expect(sanitizeStderr(`${ESC}_open\nkept`)).toBe('\nkept');
    expect(sanitizeStderr(`${ESC}Pq open\nkept`)).toBe('\nkept');
  });

  it.each([
    ['DCS', '\u0090'],
    ['SOS', '\u0098'],
    ['PM', '\u009e'],
    ['APC', '\u009f'],
  ])('8-bit %s ended by ST, by BEL or by a line break', (_name, intro) => {
    expect(sanitizeStderr(`a${intro}payload\u009cb`)).toBe('ab');
    expect(sanitizeStderr(`a${intro}payload\u0007b`)).toBe('ab');
    expect(sanitizeStderr(`a${intro}payload\nb`)).toBe('a\nb');
  });

  it('an unfinished 8-bit OSC ends at the line break', () => {
    expect(sanitizeStderr('a\u009d0;title\nb')).toBe('a\nb');
  });

  it('plain text after a damaged sequence is kept', () => {
    expect(sanitizeStderr(`${ESC}]8;;http://x${ESC}[31mred`)).toBe('red');
    expect(sanitizeStderr(`error: ${ESC}[`)).toBe('error: ');
  });
});

describe('jobs.background with malformed entries (D2)', () => {
  const bg = (tasks: unknown) => ({ type: 'system', subtype: 'background_tasks_changed', tasks });

  it.each([
    ['an empty task_id', [{ task_id: 'a' }, { task_id: '' }]],
    ['a missing task_id', [{ task_id: 'a' }, {}]],
    ['a non-object entry', [{ task_id: 'a' }, 'b', null, 5]],
    ['a non-string task_id', [{ task_id: 'a' }, { task_id: 7 }]],
    ['only bad entries', [{}]],
  ])('%s: no jobs.background (no false idle), one protocol_malformed', (_name, tasks) => {
    const out = normalize(initialNormalizerState(), bg(tasks));
    expect(out.events).toEqual([
      {
        kind: 'notice',
        level: 'warning',
        code: 'protocol_malformed',
        type: 'system/background_tasks_changed',
        field: 'task_id',
      },
    ]);
    expect(consoleEventSchema.safeParse(out.events[0]).success).toBe(true);
  });

  it('a repeated malformed entry is reported once, and still gives no jobs.background', () => {
    const first = normalize(initialNormalizerState(), bg([{}]));
    const second = normalize(first.state, bg([{ task_id: '' }]));
    expect(second.events).toEqual([]);
    expect(second.dropped).toEqual(expect.any(String));
  });

  it('valid entries still give jobs.background, an empty list is idle', () => {
    const state = initialNormalizerState();
    expect(normalize(state, bg([{ task_id: 'a' }, { task_id: 'b' }])).events).toEqual([
      { kind: 'jobs.background', jobIds: ['a', 'b'] },
    ]);
    expect(normalize(state, bg([])).events).toEqual([{ kind: 'jobs.background', jobIds: [] }]);
  });
});

describe('summary and preview hygiene (D3)', () => {
  const ESC = '\u001b';

  it('summary is one line: line breaks, tabs and controls become single spaces', () => {
    expect(summarizeToolInput('Bash', { command: 'echo a\n\nb\r\nc\td' })).toBe('echo a b c d');
    expect(summarizeToolInput('Bash', { command: `ls${ESC}[31m -la\u0007\u0000` })).toBe('ls -la');
    expect(summarizeToolInput('Bash', { command: 'a\u0085b c' })).toBe('a b c');
  });

  it('summary is trimmed and capped at 300 after cleaning', () => {
    const out = summarizeToolInput('Bash', { command: `\n  ${'x'.repeat(400)}\n` });
    expect(out).toBe('x'.repeat(300));
  });

  it('summary keeps its cap without splitting a surrogate pair', () => {
    const out = summarizeToolInput('Bash', { command: `${'x'.repeat(299)}😀` });
    expect(out.length).toBe(299);
  });

  const result = (content: unknown) => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
  });
  const previewOf = (content: unknown) => {
    const e = normalize(initialNormalizerState(), result(content)).events[0];
    return e?.kind === 'tool.result' ? e.preview : undefined;
  };

  it('preview drops ANSI and control characters, and keeps line breaks and tabs', () => {
    expect(previewOf(`${ESC}[31mred${ESC}[0m\u0007\u0000 ok\nnext\tcol`)).toBe('red ok\nnext\tcol');
  });

  it('preview turns CRLF and lone CR into LF and caps runs of empty lines', () => {
    expect(previewOf('a\r\nb\rc\n\n\n\n\nd')).toBe('a\nb\nc\n\nd');
  });

  it('preview of text parts is cleaned the same way', () => {
    expect(
      previewOf([
        { type: 'text', text: `a${ESC}[1mb` },
        { type: 'text', text: 'c\u0007' },
      ]),
    ).toBe('ab\nc');
  });

  it('preview keeps the 2 KB cap', () => {
    expect(previewOf('y'.repeat(5000))?.length).toBe(2048);
  });

  it('tool.call from an assistant message has a one-line summary', () => {
    const out = normalize(initialNormalizerState(), {
      type: 'assistant',
      message: {
        id: 'm1',
        content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'a\nb' } }],
      },
    });
    expect(out.events).toMatchObject([{ kind: 'tool.call', summary: 'a b' }]);
    expect(consoleEventSchema.safeParse(out.events[0]).success).toBe(true);
  });
});

describe('fixtures: texts, jobs and turn ends', () => {
  type Block = { type: string; text?: string };
  const textBlocks = (name: string) =>
    readMessages(name).flatMap((m) => {
      if (m.type !== 'assistant') return [];
      const inner = m.message as { id?: string; content?: Block[] };
      return (inner.content ?? []).flatMap((b) =>
        b.type === 'text' && typeof b.text === 'string' && b.text !== ''
          ? [{ apiMessageId: inner.id, text: b.text }]
          : [],
      );
    });

  it.each(FIXTURES)('%s: every non-empty assistant text block becomes assistant.text', (name) => {
    const expected = textBlocks(name);
    const actual = ofKind(fixture(name).events, 'assistant.text');
    expect(actual.map((a) => a.apiMessageId)).toEqual(expected.map((a) => a.apiMessageId));
    expect(actual.map((a) => a.text)).toEqual(expected.map((a) => a.text.slice(0, 32 * 1024)));
  });

  it('multi-message: assistant.text events carry the ids of their API messages', () => {
    const expected = textBlocks('multi-message');
    expect(new Set(expected.map((e) => e.apiMessageId)).size).toBeGreaterThanOrEqual(2);
    const texts = ofKind(fixture('multi-message').events, 'assistant.text');
    expect(texts).toHaveLength(expected.length);
    expect(texts.map((t) => t.apiMessageId)).toEqual(expected.map((e) => e.apiMessageId));
  });

  it.each(['subagent', 'mid-turn-message'])(
    '%s: every job.started with a toolUseId follows the tool.call that spawned it',
    (name) => {
      const { events } = fixture(name);
      const started = ofKind(events, 'job.started');
      expect(started.length).toBeGreaterThan(0);
      for (const job of started) {
        expect(job.toolUseId).toEqual(expect.any(String));
        const call = events.findIndex(
          (e) => e.kind === 'tool.call' && e.toolUseId === job.toolUseId,
        );
        expect(call).toBeGreaterThanOrEqual(0);
        expect(call).toBeLessThan(events.indexOf(job));
      }
    },
  );

  const resultMsg = (extra: Record<string, unknown>) => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    terminal_reason: 'completed',
    ...extra,
  });
  const ended = (extra: Record<string, unknown>) =>
    normalize(initialNormalizerState(), resultMsg(extra)).events[0];

  it('turn.ended carries denials, stopReason, durationMs and costUsd', () => {
    expect(
      ended({
        permission_denials: [{}, {}],
        stop_reason: 'end_turn',
        duration_ms: 1234,
        total_cost_usd: 0.05,
      }),
    ).toEqual({
      kind: 'turn.ended',
      turn: 1,
      isError: false,
      terminalReason: 'completed',
      stopReason: 'end_turn',
      subtype: 'success',
      durationMs: 1234,
      costUsd: 0.05,
      denials: 2,
    });
  });

  it('turn.ended: null stop_reason is kept as null, bad values are left out', () => {
    expect(ended({ stop_reason: null })).toMatchObject({ stopReason: null });
    const bad = ended({
      stop_reason: 5,
      duration_ms: -1,
      total_cost_usd: 'x',
      permission_denials: 'no',
    });
    expect(bad).not.toHaveProperty('stopReason');
    expect(bad).not.toHaveProperty('durationMs');
    expect(bad).not.toHaveProperty('costUsd');
    expect(bad).toMatchObject({ denials: 0 });
    expect(consoleEventSchema.safeParse(bad).success).toBe(true);
  });
});

describe('normalize does not mutate the state it was given', () => {
  const snapshot = (s: NormalizerState) => ({
    turn: s.turn,
    turnOpen: s.turnOpen,
    model: s.model,
    unknownSeen: [...s.unknownSeen],
    malformedSeen: [...s.malformedSeen],
    endedJobs: [...s.endedJobs],
    lastProgress: [...s.lastProgress],
  });

  it.each([
    ['unknown type', { type: 'mystery' }],
    ['unknown system subtype', { type: 'system', subtype: 'mystery' }],
    ['malformed field', { type: 'system', subtype: 'task_started' }],
    [
      'job end',
      { type: 'system', subtype: 'task_updated', task_id: 'j', patch: { status: 'completed' } },
    ],
    ['job progress', { type: 'system', subtype: 'task_progress', task_id: 'j', description: 'd' }],
    ['init', { type: 'system', subtype: 'init', model: 'm' }],
  ])('%s', (_name, message) => {
    const before = initialNormalizerState();
    const frozen = snapshot(before);
    const out = normalize(before, message);
    expect(snapshot(before)).toEqual(frozen);
    expect(out.state).not.toBe(before);
  });

  it('a whole fixture leaves every earlier state as it was', () => {
    let state = initialNormalizerState();
    for (const message of readMessages('subagent')) {
      const frozen = snapshot(state);
      const next = normalize(state, message).state;
      expect(snapshot(state)).toEqual(frozen);
      state = next;
    }
  });
});
