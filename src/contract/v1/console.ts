import { z } from 'zod';
import { COMMENT_MAX_LENGTH } from '../../core/model/aiRun.js';
import { CONSOLE_PHASES } from '../../core/rules/console.js';

/**
 * The contract of Console mode (plan C3, §3.3, §3.4, §4.2, §9.3): the events Board writes to the
 * console journal, the bodies of the console routes and the frames of the runner's inbox. Every
 * object is strict, and no text carries NUL. The routes themselves come with C7 and C10.
 */

/** A batch of events carries 0..50 of them; an empty one is the control batch (§8.2). */
export const CONSOLE_EVENTS_MAX_BATCH = 50;

const KB = 1024;
const noNul = (value: string) => !value.includes('\0');
const text = (max: number) => z.string().max(max).refine(noNul, 'Must not contain NUL');
const nonEmptyText = (max: number) =>
  z.string().min(1).max(max).refine(noNul, 'Must not contain NUL');
const id = z.string().min(1).max(200);
const scope = z.string().min(1).max(200).nullable();
const count = z.number().int().min(0);

/** The text of a message: 1..4000, not blank, no NUL; the rule of `comment` (§3.4). */
const messageTextSchema = nonEmptyText(COMMENT_MAX_LENGTH).refine(
  (value) => /\S/.test(value),
  'Must not be blank',
);

/** What the process reports (`queued`…`cancelled`) and what the server settles at the end. */
const PROTOCOL_LIFECYCLE_STATES = ['queued', 'started', 'completed', 'cancelled'] as const;
const SYNTHETIC_LIFECYCLE_STATES = ['undelivered', 'interrupted'] as const;
export const CONSOLE_LIFECYCLE_CAUSES = ['exited', 'ended', 'lost'] as const;

const lifecycleEvent = z
  .strictObject({
    kind: z.literal('user.lifecycle'),
    messageId: z.uuid(),
    state: z.enum([...PROTOCOL_LIFECYCLE_STATES, ...SYNTHETIC_LIFECYCLE_STATES]),
    /** Only on the synthetic states, written by the server (§9.4). */
    cause: z.enum(CONSOLE_LIFECYCLE_CAUSES).optional(),
  })
  .refine(
    (event) =>
      (SYNTHETIC_LIFECYCLE_STATES as readonly string[]).includes(event.state) ===
      (event.cause !== undefined),
    'cause belongs to undelivered and interrupted only',
  );

/** The fields each notice code carries, and no others (§3.3, §4.2, §4.5). */
const NOTICE_FIELDS = {
  rate_limit: ['text'],
  api_retry: ['text'],
  events_missing: ['fromRunnerSeq', 'toRunnerSeq'],
  protocol_malformed: ['type', 'field'],
} as const;
const NOTICE_EXTRA = ['text', 'fromRunnerSeq', 'toRunnerSeq', 'type', 'field'] as const;

const noticeEvent = z
  .strictObject({
    kind: z.literal('notice'),
    level: z.enum(['info', 'warning', 'error']),
    code: z.enum(['rate_limit', 'api_retry', 'events_missing', 'protocol_malformed']),
    text: text(KB).optional(),
    fromRunnerSeq: z.number().int().min(1).optional(),
    toRunnerSeq: z.number().int().min(1).optional(),
    type: id.optional(),
    field: id.optional(),
  })
  .refine((event) => {
    const wanted: readonly string[] = NOTICE_FIELDS[event.code];
    return NOTICE_EXTRA.every((name) => (event[name] !== undefined) === wanted.includes(name));
  }, 'A notice carries the fields of its code, and only those');

const reason = z.string().min(1).max(100);

export const consoleEventSchema = z.discriminatedUnion('kind', [
  lifecycleEvent,
  z.strictObject({ kind: z.literal('user.replayed'), messageId: z.uuid() }),
  z.strictObject({
    kind: z.literal('user.message'),
    origin: z.enum(['board', 'prompt']),
    messageId: z.uuid(),
    text: nonEmptyText(COMMENT_MAX_LENGTH),
  }),
  z.strictObject({
    kind: z.literal('turn.started'),
    turn: z.number().int().min(1),
    userMessageIds: z.array(z.uuid()),
    model: id.optional(),
  }),
  z.strictObject({
    kind: z.literal('assistant.text'),
    apiMessageId: id,
    scope,
    text: text(32 * KB),
  }),
  z.strictObject({
    kind: z.literal('tool.call'),
    toolUseId: id,
    tool: id,
    summary: text(300),
    scope,
  }),
  z.strictObject({
    kind: z.literal('tool.result'),
    toolUseId: id,
    isError: z.boolean(),
    preview: text(2 * KB),
    scope,
  }),
  z.strictObject({
    kind: z.literal('job.started'),
    jobId: id,
    toolUseId: id.optional(),
    jobType: id,
    description: text(2 * KB),
    backgrounded: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('job.progress'),
    jobId: id,
    description: text(2 * KB),
    lastTool: id.optional(),
  }),
  // The status is the string Claude sent; only "completed" is known to end a job (§4.4).
  z.strictObject({ kind: z.literal('job.updated'), jobId: id, status: id }),
  z.strictObject({
    kind: z.literal('job.notified'),
    jobId: id,
    status: id.optional(),
    summary: text(2 * KB).optional(),
  }),
  z.strictObject({
    kind: z.literal('job.ended'),
    jobId: id,
    status: z.literal('completed'),
  }),
  z.strictObject({ kind: z.literal('jobs.background'), jobIds: z.array(id) }),
  z.strictObject({
    kind: z.literal('permission.denied'),
    tool: id,
    toolUseId: id.optional(),
    message: text(KB),
    reasonType: id.optional(),
  }),
  z.strictObject({
    kind: z.literal('turn.ended'),
    turn: z.number().int().min(1),
    isError: z.boolean(),
    terminalReason: id.optional(),
    stopReason: id.nullable().optional(),
    subtype: id.optional(),
    durationMs: count.optional(),
    costUsd: z.number().min(0).optional(),
    denials: count,
  }),
  noticeEvent,
  z.strictObject({
    kind: z.literal('protocol.unknown'),
    type: id,
    subtype: id.optional(),
  }),
  z.strictObject({ kind: z.literal('runner.stderr'), text: text(4 * KB) }),
  z.strictObject({ kind: z.literal('process.started'), pid: z.number().int().min(0) }),
  z.strictObject({ kind: z.literal('compat.passed') }),
  z.strictObject({
    kind: z.literal('compat.failed'),
    reason,
    claudeVersion: id.optional(),
  }),
  z.strictObject({
    kind: z.literal('session.info'),
    claudeVersion: id,
    model: id.optional(),
    permissionMode: id.optional(),
  }),
  z.strictObject({
    kind: z.literal('close.requested'),
    reason: z.enum(['board', 'agent-final', 'incompatible', 'signal']),
  }),
  z.strictObject({ kind: z.literal('kill.requested'), reason }),
  z.strictObject({
    kind: z.literal('process.exited'),
    exitCode: z.number().int().nullable(),
    signal: id.nullable(),
    lastTurnOpen: z.boolean(),
  }),
]);
export type ConsoleEvent = z.infer<typeof consoleEventSchema>;

/** One line of the journal: `seq` is the server's, `runnerSeq` the runner's (§3.3, §9.1). */
export const consoleEntrySchema = z.strictObject({
  seq: z.number().int().min(1),
  at: z.iso.datetime({ offset: true }),
  source: z.enum(['runner', 'server']),
  runnerSeq: z.number().int().min(1).optional(),
  event: consoleEventSchema,
});
export type ConsoleEntry = z.infer<typeof consoleEntrySchema>;

/** `events[i]` has `runnerSeq = fromRunnerSeq + i`; an empty batch is a control batch. */
export const consoleEventsBody = z.strictObject({
  fromRunnerSeq: z.number().int().min(1),
  events: z.array(consoleEventSchema).max(CONSOLE_EVENTS_MAX_BATCH),
});
export type ConsoleEventsBody = z.infer<typeof consoleEventsBody>;

/** The answer to a batch: the cursor the server confirms, and the messages still `accepted`. */
export const consoleEventsResponse = z.strictObject({
  lastRunnerSeq: count,
  awaitingDelivery: count,
});
export type ConsoleEventsResponse = z.infer<typeof consoleEventsResponse>;

/** The session the batch is for; the runner sends it with every batch (plan C7, CAS). */
export const consoleEventsQuery = z.strictObject({ sessionId: z.uuid() });

/** How many entries one read answers, by default and at most. */
export const CONSOLE_READ_DEFAULT_LIMIT = 200;
export const CONSOLE_READ_MAX_LIMIT = 1000;

/**
 * `after`: the entries with a greater `seq`, the first `limit` of them. `before` alone: the last
 * `limit` entries with a smaller `seq`, the way back through a long journal. Both: between.
 */
export const consoleReadQuery = z.strictObject({
  after: z.coerce.number().int().min(0).optional(),
  before: z.coerce.number().int().min(0).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CONSOLE_READ_MAX_LIMIT)
    .default(CONSOLE_READ_DEFAULT_LIMIT),
});
export type ConsoleReadQuery = z.infer<typeof consoleReadQuery>;

const messageStatus = z.enum([
  'accepted',
  'queued',
  'started',
  'completed',
  'cancelled',
  'undelivered',
  'interrupted',
]);

/** The state `foldConsole` computes (C5), as the read route sends it (plan §5). */
export const consoleStateSchema = z.strictObject({
  process: z.strictObject({
    status: z.enum(['starting', 'running', 'closing', 'exited', 'lost']),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
    killRequested: z.boolean(),
  }),
  compat: z.strictObject({
    status: z.enum(['probing', 'compatible', 'incompatible', 'unknown']),
    reason: z.string().optional(),
  }),
  turn: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('none'),
      lastTurn: z
        .strictObject({
          turn: z.number().int(),
          isError: z.boolean(),
          terminalReason: z.string().optional(),
        })
        .optional(),
    }),
    z.strictObject({
      status: z.literal('active'),
      turn: z.number().int(),
      origin: z.enum(['user', 'internal']),
    }),
    z.strictObject({ status: z.literal('interrupted'), turn: z.number().int() }),
  ]),
  jobs: z.array(z.string()),
  messages: z.array(
    z.strictObject({
      messageId: z.string(),
      origin: z.enum(['board', 'prompt']),
      text: z.string(),
      acceptedSeq: z.number().int(),
      status: messageStatus,
      join: z
        .strictObject({
          how: z.enum(['new-turn', 'joined-turn']),
          turn: z.number().int(),
          together: z.array(z.string()),
        })
        .optional(),
      replayed: z.boolean(),
    }),
  ),
  counters: z.strictObject({
    awaitingDelivery: count,
    pendingProcessing: count,
    inProgress: count,
  }),
  phase: z.enum(CONSOLE_PHASES),
});

/** The answer of the read: a page of the journal, and the state of the whole of it. */
export const consoleReadResponse = z.strictObject({
  entries: z.array(consoleEntrySchema),
  state: consoleStateSchema,
});
export type ConsoleReadResponse = z.infer<typeof consoleReadResponse>;

export const consoleMessageBody = z.strictObject({
  sessionId: z.uuid(),
  messageId: z.uuid(),
  text: messageTextSchema,
});
export const consoleCloseBody = z.strictObject({ sessionId: z.uuid() });
export const consoleKillBody = z.strictObject({ sessionId: z.uuid() });

/** What the server sends a runner on its inbox (§9.3). */
export const inboxFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('message'), messageId: z.uuid(), text: messageTextSchema }),
  z.strictObject({ type: z.literal('close') }),
  z.strictObject({ type: z.literal('kill') }),
  z.strictObject({
    type: z.literal('agent-final'),
    state: z.enum(['finished', 'failed', 'needs-review']),
  }),
]);
export type InboxFrame = z.infer<typeof inboxFrameSchema>;

/** The inbox is read for the same run and session a batch is written for (§9.3). */
export const consoleInboxQuery = consoleEventsQuery;

/** The answer to a message: its id and the `seq` of its entry. 201 when written, 200 for a repeat. */
export const consoleMessageResponse = z.strictObject({
  messageId: z.uuid(),
  seq: z.number().int().min(1),
});
export type ConsoleMessageResponse = z.infer<typeof consoleMessageResponse>;

/** The answer to close and kill: the request is taken (C10, §8.2, §8.3). */
export const consoleSignalResponse = z.strictObject({ requested: z.literal(true) });
export type ConsoleSignalResponse = z.infer<typeof consoleSignalResponse>;
