import {
  CONSOLE_EVENTS_MAX_BATCH,
  consoleCloseBody,
  consoleEntrySchema,
  consoleEventSchema,
  consoleEventsBody,
  consoleEventsResponse,
  consoleKillBody,
  consoleMessageBody,
  inboxFrameSchema,
} from '../../src/contract/v1/index.js';

const UUID = '3f2b8c1e-5a4d-4e7b-9c2a-1d6e8f0a7b35';
const SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const good = {
  lifecycle: { kind: 'user.lifecycle', messageId: UUID, state: 'queued' },
  undelivered: { kind: 'user.lifecycle', messageId: UUID, state: 'undelivered', cause: 'exited' },
  interrupted: { kind: 'user.lifecycle', messageId: UUID, state: 'interrupted', cause: 'lost' },
  replayed: { kind: 'user.replayed', messageId: UUID },
  prompt: { kind: 'user.message', origin: 'prompt', messageId: UUID, text: 'see handoff' },
  board: { kind: 'user.message', origin: 'board', messageId: UUID, text: 'hello' },
  turnStarted: { kind: 'turn.started', turn: 1, userMessageIds: [UUID], model: 'claude-x' },
  text: { kind: 'assistant.text', apiMessageId: 'msg_1', scope: null, text: 'hi' },
  call: { kind: 'tool.call', toolUseId: 't1', tool: 'Bash', summary: 'ls', scope: null },
  result: { kind: 'tool.result', toolUseId: 't1', isError: false, preview: 'ok', scope: null },
  jobStarted: {
    kind: 'job.started',
    jobId: 'j1',
    toolUseId: 't1',
    jobType: 'local_bash',
    description: 'd',
    backgrounded: true,
  },
  jobProgress: { kind: 'job.progress', jobId: 'j1', description: 'd', lastTool: 'Bash' },
  jobUpdated: { kind: 'job.updated', jobId: 'j1', status: 'running' },
  jobNotified: { kind: 'job.notified', jobId: 'j1', status: 'completed', summary: 's' },
  jobEnded: { kind: 'job.ended', jobId: 'j1', status: 'completed' },
  jobsBackground: { kind: 'jobs.background', jobIds: ['j1'] },
  denied: {
    kind: 'permission.denied',
    tool: 'Bash',
    toolUseId: 't1',
    message: 'no',
    reasonType: 'rule',
  },
  turnEnded: {
    kind: 'turn.ended',
    turn: 1,
    isError: false,
    terminalReason: 'completed',
    stopReason: 'end_turn',
    subtype: 'success',
    durationMs: 10,
    costUsd: 0.01,
    denials: 0,
  },
  notice: { kind: 'notice', level: 'warning', code: 'rate_limit', text: 'slow' },
  missing: {
    kind: 'notice',
    level: 'warning',
    code: 'events_missing',
    fromRunnerSeq: 3,
    toRunnerSeq: 5,
  },
  malformed: {
    kind: 'notice',
    level: 'warning',
    code: 'protocol_malformed',
    type: 'result',
    field: 'terminal_reason',
  },
  unknown: { kind: 'protocol.unknown', type: 'weird', subtype: 'x' },
  stderr: { kind: 'runner.stderr', text: 'oops' },
  started: { kind: 'process.started', pid: 42 },
  passed: { kind: 'compat.passed' },
  failed: { kind: 'compat.failed', reason: 'no-lifecycle', claudeVersion: '2.1.330' },
  info: { kind: 'session.info', claudeVersion: '2.1.330', model: 'm', permissionMode: 'default' },
  close: { kind: 'close.requested', reason: 'board' },
  kill: { kind: 'kill.requested', reason: 'board' },
  exited: { kind: 'process.exited', exitCode: 0, signal: null, lastTurnOpen: false },
};

const ok = (event: object) => consoleEventSchema.safeParse(event).success;

describe('consoleEventSchema', () => {
  it.each(Object.entries(good))('accepts %s', (_name, event) => {
    expect(ok(event)).toBe(true);
  });

  it.each(Object.entries(good))('rejects an extra field on %s', (_name, event) => {
    expect(ok({ ...event, extra: 1 })).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(ok({ kind: 'nope' })).toBe(false);
  });

  it('requires a cause exactly on the synthetic lifecycle states', () => {
    expect(ok({ ...good.undelivered, cause: undefined })).toBe(false);
    expect(ok({ ...good.lifecycle, cause: 'exited' })).toBe(false);
  });

  it('takes any job status on job.updated, but only completed on job.ended', () => {
    expect(ok({ ...good.jobUpdated, status: 'killed' })).toBe(true);
    expect(ok({ ...good.jobEnded, status: 'killed' })).toBe(false);
  });

  it('limits lengths', () => {
    expect(ok({ ...good.text, text: 'a'.repeat(32 * 1024) })).toBe(true);
    expect(ok({ ...good.text, text: 'a'.repeat(32 * 1024 + 1) })).toBe(false);
    expect(ok({ ...good.result, preview: 'a'.repeat(2048) })).toBe(true);
    expect(ok({ ...good.result, preview: 'a'.repeat(2049) })).toBe(false);
    expect(ok({ ...good.jobNotified, summary: 'a'.repeat(2048) })).toBe(true);
    expect(ok({ ...good.jobNotified, summary: 'a'.repeat(2049) })).toBe(false);
    expect(ok({ ...good.call, summary: 'a'.repeat(300) })).toBe(true);
    expect(ok({ ...good.call, summary: 'a'.repeat(301) })).toBe(false);
    expect(ok({ ...good.denied, message: 'a'.repeat(1024) })).toBe(true);
    expect(ok({ ...good.denied, message: 'a'.repeat(1025) })).toBe(false);
    expect(ok({ ...good.stderr, text: 'a'.repeat(4096) })).toBe(true);
    expect(ok({ ...good.stderr, text: 'a'.repeat(4097) })).toBe(false);
    expect(ok({ ...good.board, text: 'a'.repeat(4000) })).toBe(true);
    expect(ok({ ...good.board, text: 'a'.repeat(4001) })).toBe(false);
  });

  it('refuses NUL in text', () => {
    expect(ok({ ...good.text, text: 'a\0b' })).toBe(false);
    expect(ok({ ...good.stderr, text: '\0' })).toBe(false);
    expect(ok({ ...good.board, text: 'a\0' })).toBe(false);
  });

  it('takes a messageId only as a UUID', () => {
    expect(ok({ ...good.board, messageId: 'abc' })).toBe(false);
    expect(ok({ ...good.replayed, messageId: 'abc' })).toBe(false);
    expect(ok({ ...good.lifecycle, messageId: 'abc' })).toBe(false);
  });
});

describe('consoleEntrySchema', () => {
  const entry = {
    seq: 1,
    at: '2026-09-21T11:30:00.000Z',
    source: 'runner',
    runnerSeq: 1,
    event: good.text,
  };

  it('accepts runner and server entries', () => {
    expect(consoleEntrySchema.safeParse(entry).success).toBe(true);
    const server = { seq: 2, at: entry.at, source: 'server', event: good.missing };
    expect(consoleEntrySchema.safeParse(server).success).toBe(true);
  });

  it('is strict and validates the event', () => {
    expect(consoleEntrySchema.safeParse({ ...entry, extra: 1 }).success).toBe(false);
    expect(consoleEntrySchema.safeParse({ ...entry, source: 'web' }).success).toBe(false);
    expect(consoleEntrySchema.safeParse({ ...entry, seq: 0 }).success).toBe(false);
    expect(consoleEntrySchema.safeParse({ ...entry, event: { kind: 'x' } }).success).toBe(false);
  });
});

describe('consoleEventsBody', () => {
  const body = (fromRunnerSeq: number, n: number) => ({
    fromRunnerSeq,
    events: Array.from({ length: n }, () => good.text),
  });
  const parses = (value: unknown) => consoleEventsBody.safeParse(value).success;

  it('refuses fromRunnerSeq below 1 or fractional', () => {
    expect(parses(body(0, 1))).toBe(false);
    expect(parses(body(1.5, 1))).toBe(false);
    expect(parses(body(-1, 1))).toBe(false);
  });

  it('takes 0..50 events', () => {
    expect(CONSOLE_EVENTS_MAX_BATCH).toBe(50);
    expect(parses(body(1, 0))).toBe(true);
    expect(parses(body(1, 1))).toBe(true);
    expect(parses(body(7, 50))).toBe(true);
    expect(parses(body(1, 51))).toBe(false);
  });

  it('is strict and validates each event', () => {
    expect(parses({ ...body(1, 1), extra: 1 })).toBe(false);
    expect(parses({ fromRunnerSeq: 1, events: [{ kind: 'x' }] })).toBe(false);
  });
});

describe('consoleEventsResponse', () => {
  const parses = (value: unknown) => consoleEventsResponse.safeParse(value).success;

  it('is {lastRunnerSeq, awaitingDelivery}', () => {
    expect(parses({ lastRunnerSeq: 0, awaitingDelivery: 0 })).toBe(true);
    expect(parses({ lastRunnerSeq: 7, awaitingDelivery: 2 })).toBe(true);
    expect(parses({ lastRunnerSeq: -1, awaitingDelivery: 0 })).toBe(false);
    expect(parses({ lastRunnerSeq: 1.5, awaitingDelivery: 0 })).toBe(false);
    expect(parses({ lastRunnerSeq: 1 })).toBe(false);
    expect(parses({ lastRunnerSeq: 1, awaitingDelivery: 0, x: 1 })).toBe(false);
  });
});

describe('message, close and kill bodies', () => {
  const msg = { sessionId: SESSION, messageId: UUID, text: 'hello' };
  const parses = (value: unknown) => consoleMessageBody.safeParse(value).success;

  it('takes text 1..4000, not blank, without NUL', () => {
    expect(parses({ ...msg, text: 'a' })).toBe(true);
    expect(parses({ ...msg, text: 'a'.repeat(4000) })).toBe(true);
    expect(parses({ ...msg, text: '' })).toBe(false);
    expect(parses({ ...msg, text: '   \n\t' })).toBe(false);
    expect(parses({ ...msg, text: 'a'.repeat(4001) })).toBe(false);
    expect(parses({ ...msg, text: 'a\0' })).toBe(false);
  });

  it('takes ids only as UUIDs and is strict', () => {
    expect(parses({ ...msg, messageId: 'x' })).toBe(false);
    expect(parses({ ...msg, sessionId: 'x' })).toBe(false);
    expect(parses({ ...msg, extra: 1 })).toBe(false);
  });

  it('close and kill carry the session', () => {
    for (const schema of [consoleCloseBody, consoleKillBody]) {
      expect(schema.safeParse({ sessionId: SESSION }).success).toBe(true);
      expect(schema.safeParse({ sessionId: 'x' }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ sessionId: SESSION, extra: 1 }).success).toBe(false);
    }
  });
});

describe('inboxFrameSchema', () => {
  const parses = (value: unknown) => inboxFrameSchema.safeParse(value).success;

  it('accepts the four frames', () => {
    expect(parses({ type: 'message', messageId: UUID, text: 'hi' })).toBe(true);
    expect(parses({ type: 'close' })).toBe(true);
    expect(parses({ type: 'kill' })).toBe(true);
    expect(parses({ type: 'agent-final', state: 'finished' })).toBe(true);
  });

  it('rejects unknown types, extra fields, a bad id or text, a non-final state', () => {
    expect(parses({ type: 'nope' })).toBe(false);
    expect(parses({ type: 'close', extra: 1 })).toBe(false);
    expect(parses({ type: 'message', messageId: 'x', text: 'hi' })).toBe(false);
    expect(parses({ type: 'message', messageId: UUID, text: '' })).toBe(false);
    expect(parses({ type: 'message', messageId: UUID, text: 'a\0' })).toBe(false);
    expect(parses({ type: 'agent-final', state: 'working' })).toBe(false);
  });
});
