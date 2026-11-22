import type { AiRun } from '../model/aiRun.js';

/**
 * The state model of Console mode (plan C5, §3.2, §5, §9.4): pure functions of the journal.
 * Nothing is stored; `foldConsole` computes the state again from the entries, `finalizeMessages`
 * says what the server must write when the process is gone, and `acceptsMessages` is the one rule
 * of whether a session takes a message.
 *
 * The events are described here by the structure the model reads, not imported from the contract
 * (ADR-0016): an entry of the C3 contract (`ConsoleEntry`) fits `ConsoleFoldEntry` as it is, and
 * a test keeps it so.
 */

/** Why the server settles the messages: the process exited, the run ended, or it was lost (§9.4). */
export type ConsoleFinalizeCause = 'exited' | 'ended' | 'lost';

/** Why a session does not take a message now. HTTP codes for these come with C10. */
export type ConsoleRefusal = 'CONSOLE_NOT_READY' | 'CONSOLE_UNAVAILABLE' | 'STALE_AI_RUN';
export type ConsoleAcceptance = { ok: true } | { ok: false; reason: ConsoleRefusal };

/**
 * What Claude is doing, for a human (§5.2). Waiting for a delivery or for an answer is not a
 * phase: the first belongs to the messages (E), the second the protocol does not tell.
 */
export const CONSOLE_PHASES = [
  'failed',
  'ended',
  'starting',
  'closing',
  'working',
  'background',
  'idle',
] as const;
export type ConsolePhase = (typeof CONSOLE_PHASES)[number];

export type ConsoleMessageStatus =
  'accepted' | 'queued' | 'started' | 'completed' | 'cancelled' | 'undelivered' | 'interrupted';

export interface ConsoleMessageView {
  readonly messageId: string;
  readonly origin: 'board' | 'prompt';
  readonly text: string;
  readonly acceptedSeq: number;
  readonly status: ConsoleMessageStatus;
  /** How it was taken: into a new turn (by `userMessageIds`) or poured into a running one. */
  readonly join?: {
    readonly how: 'new-turn' | 'joined-turn';
    readonly turn: number;
    readonly together: readonly string[];
  };
  readonly replayed: boolean;
}

export interface ConsoleState {
  /** A. `lost` is not in the journal: the server says it (`options.lost`) after an abandon. */
  readonly process: {
    readonly status: 'starting' | 'running' | 'closing' | 'exited' | 'lost';
    readonly exitCode?: number | null;
    readonly signal?: string | null;
    readonly killRequested: boolean;
  };
  /** B. */
  readonly compat: {
    readonly status: 'probing' | 'compatible' | 'incompatible' | 'unknown';
    readonly reason?: string;
  };
  /** C. The main dialogue only. */
  readonly turn:
    | {
        readonly status: 'none';
        readonly lastTurn?: {
          readonly turn: number;
          readonly isError: boolean;
          readonly terminalReason?: string;
        };
      }
    | { readonly status: 'active'; readonly turn: number; readonly origin: 'user' | 'internal' }
    | { readonly status: 'interrupted'; readonly turn: number };
  /** D. The ids of the active background jobs. */
  readonly jobs: readonly string[];
  /** E. In the order of `user.message`. */
  readonly messages: readonly ConsoleMessageView[];
  /** E. Each non-terminal message is in exactly one of them. */
  readonly counters: {
    readonly awaitingDelivery: number;
    readonly pendingProcessing: number;
    readonly inProgress: number;
  };
  readonly phase: ConsolePhase;
}

/** The events the model reads, and the kinds it passes over (the rest of the C3 contract). */
type FoldEvent =
  | { kind: 'user.message'; origin: 'board' | 'prompt'; messageId: string; text: string }
  | {
      kind: 'user.lifecycle';
      messageId: string;
      state: 'queued' | 'started' | 'completed' | 'cancelled' | 'undelivered' | 'interrupted';
    }
  | { kind: 'user.replayed'; messageId: string }
  | { kind: 'turn.started'; turn: number; userMessageIds: readonly string[] }
  | { kind: 'turn.ended'; turn: number; isError: boolean; terminalReason?: string | undefined }
  | { kind: 'job.started'; jobId: string; backgrounded: boolean }
  | { kind: 'job.ended'; jobId: string }
  | { kind: 'jobs.background'; jobIds: readonly string[] }
  | { kind: 'process.started' }
  | { kind: 'close.requested' }
  | { kind: 'kill.requested' }
  | { kind: 'process.exited'; exitCode: number | null; signal: string | null }
  | { kind: 'compat.passed' }
  | { kind: 'compat.failed'; reason: string }
  | {
      kind:
        | 'assistant.text'
        | 'tool.call'
        | 'tool.result'
        | 'job.progress'
        | 'job.updated'
        | 'job.notified'
        | 'permission.denied'
        | 'notice'
        | 'protocol.unknown'
        | 'runner.stderr'
        | 'session.info';
    };

export interface ConsoleFoldEntry {
  readonly seq: number;
  readonly event: FoldEvent;
}

export interface ConsoleFinalizeEvent {
  kind: 'user.lifecycle';
  messageId: string;
  state: 'undelivered' | 'interrupted';
  cause: ConsoleFinalizeCause;
}

/** Order of the statuses: an event that would lower it is ignored (§3.2). */
const RANK: Record<ConsoleMessageStatus, number> = {
  accepted: 0,
  queued: 1,
  started: 2,
  completed: 3,
  cancelled: 3,
  undelivered: 3,
  interrupted: 3,
};

interface Draft {
  messageId: string;
  origin: 'board' | 'prompt';
  text: string;
  acceptedSeq: number;
  status: ConsoleMessageStatus;
  join?: { how: 'new-turn' | 'joined-turn'; turn: number; together: string[] };
  replayed: boolean;
}

/** The state of the console, computed from its journal (§5). Pure: the entries are not kept. */
export function foldConsole(
  entries: readonly ConsoleFoldEntry[],
  options: { lost?: boolean } = {},
): ConsoleState {
  let process: { -readonly [K in keyof ConsoleState['process']]: ConsoleState['process'][K] } = {
    status: 'starting',
    killRequested: false,
  };
  let compat: { status: ConsoleState['compat']['status']; reason?: string } = {
    status: 'probing',
  };
  let turn: ConsoleState['turn'] = { status: 'none' };
  let jobs = new Set<string>();
  const messages = new Map<string, Draft>();

  for (const { seq, event } of entries) {
    switch (event.kind) {
      case 'user.message':
        // The same messageId twice is one message: the first stays.
        if (!messages.has(event.messageId)) {
          messages.set(event.messageId, {
            messageId: event.messageId,
            origin: event.origin,
            text: event.text,
            acceptedSeq: seq,
            status: 'accepted',
            replayed: false,
          });
        }
        break;
      case 'user.replayed': {
        const message = messages.get(event.messageId);
        if (message !== undefined) message.replayed = true;
        break;
      }
      case 'user.lifecycle': {
        const message = messages.get(event.messageId);
        if (message === undefined) break; // not a message of this journal
        if (RANK[event.state] > RANK[message.status]) message.status = event.state;
        if (event.state === 'started' && message.join === undefined && turn.status === 'active') {
          message.join = { how: 'joined-turn', turn: turn.turn, together: [message.messageId] };
        }
        break;
      }
      case 'turn.started': {
        // A turn that is already active is replaced: the new one is the active turn.
        turn = {
          status: 'active',
          turn: event.turn,
          origin: event.userMessageIds.length > 0 ? 'user' : 'internal',
        };
        for (const id of event.userMessageIds) {
          const message = messages.get(id);
          if (message !== undefined && message.join === undefined) {
            message.join = {
              how: 'new-turn',
              turn: event.turn,
              together: [...event.userMessageIds],
            };
          }
        }
        break;
      }
      case 'turn.ended':
        // Matched by state, not by the number; no active turn means nothing to close.
        if (turn.status === 'active') {
          turn = {
            status: 'none',
            lastTurn: {
              turn: event.turn,
              isError: event.isError,
              ...(event.terminalReason === undefined
                ? {}
                : { terminalReason: event.terminalReason }),
            },
          };
        }
        break;
      case 'job.started':
        if (event.backgrounded) jobs.add(event.jobId);
        break;
      case 'job.ended':
        jobs.delete(event.jobId);
        break;
      case 'jobs.background':
        // The authoritative snapshot of the set.
        jobs = new Set(event.jobIds);
        break;
      case 'process.started':
        if (process.status === 'starting') process = { ...process, status: 'running' };
        break;
      case 'close.requested':
        if (process.status === 'running') process = { ...process, status: 'closing' };
        break;
      case 'kill.requested':
        if (process.status === 'running' || process.status === 'closing') {
          process = { ...process, killRequested: true };
        }
        break;
      case 'compat.passed':
        if (compat.status === 'probing') compat = { status: 'compatible' };
        break;
      case 'compat.failed':
        if (compat.status === 'probing') compat = { status: 'incompatible', reason: event.reason };
        break;
      case 'process.exited':
        if (process.status === 'exited') break;
        process = {
          status: 'exited',
          exitCode: event.exitCode,
          signal: event.signal,
          killRequested: process.killRequested,
        };
        if (compat.status === 'probing') compat = { status: 'unknown' };
        if (turn.status === 'active') turn = { status: 'interrupted', turn: turn.turn };
        jobs = new Set();
        break;
      default:
        break; // content, activity and notices do not change the state
    }
  }

  if (options.lost === true && process.status !== 'exited') {
    process = { ...process, status: 'lost' };
    if (compat.status === 'probing') compat = { status: 'unknown' };
  }

  const views: ConsoleMessageView[] = [...messages.values()].map(
    ({ join, ...rest }): ConsoleMessageView => (join === undefined ? rest : { ...rest, join }),
  );
  const count = (status: ConsoleMessageStatus) => views.filter((m) => m.status === status).length;
  const jobIds = [...jobs];

  return {
    process,
    compat,
    turn,
    jobs: jobIds,
    messages: views,
    counters: {
      awaitingDelivery: count('accepted'),
      pendingProcessing: count('queued'),
      inProgress: count('started'),
    },
    phase: phaseOf(process, compat, turn, jobIds.length),
  };
}

/** The first rule that holds, top to bottom (§5.2). */
function phaseOf(
  process: ConsoleState['process'],
  compat: ConsoleState['compat'],
  turn: ConsoleState['turn'],
  jobCount: number,
): ConsolePhase {
  if (process.status === 'lost') return 'failed';
  if (process.status === 'exited') {
    const clean =
      process.exitCode === 0 &&
      (process.signal ?? null) === null &&
      compat.status !== 'incompatible' &&
      turn.status !== 'interrupted';
    return clean ? 'ended' : 'failed';
  }
  if (process.status === 'starting' || compat.status === 'probing') return 'starting';
  if (process.status === 'closing') return 'closing';
  if (turn.status === 'active') return 'working';
  if (jobCount > 0) return 'background';
  return 'idle';
}

/**
 * The events the server writes when the process is gone (§9.4): `accepted` and `queued` never
 * reached the model (`undelivered`), `started` has an unknown outcome (`interrupted`); terminal
 * messages stay. Idempotent: the state it reads already holds what an earlier call wrote.
 */
export function finalizeMessages(
  state: ConsoleState,
  cause: ConsoleFinalizeCause,
): ConsoleFinalizeEvent[] {
  const events: ConsoleFinalizeEvent[] = [];
  for (const message of state.messages) {
    if (message.status === 'accepted' || message.status === 'queued') {
      events.push({
        kind: 'user.lifecycle',
        messageId: message.messageId,
        state: 'undelivered',
        cause,
      });
    } else if (message.status === 'started') {
      events.push({
        kind: 'user.lifecycle',
        messageId: message.messageId,
        state: 'interrupted',
        cause,
      });
    }
  }
  return events;
}

/**
 * Whether a Console session takes a message (§5.3): the run is the current one, its end is not
 * written, the process runs, and the compatibility is known. `aiRun.state` is not read: an agent
 * that reported `finished` while the process lives does not close the session.
 */
export function acceptsMessages(
  state: ConsoleState,
  aiRun: Pick<AiRun, 'runId' | 'sessionId' | 'endedAt' | 'failure'>,
  current: { runId: number; sessionId: string },
): ConsoleAcceptance {
  if (aiRun.runId !== current.runId || aiRun.sessionId !== current.sessionId) {
    return { ok: false, reason: 'STALE_AI_RUN' };
  }
  const gone =
    aiRun.endedAt !== undefined ||
    aiRun.failure?.kind === 'lost' ||
    state.process.status === 'closing' ||
    state.process.status === 'exited' ||
    state.process.status === 'lost' ||
    state.compat.status === 'incompatible' ||
    state.compat.status === 'unknown';
  if (gone) return { ok: false, reason: 'CONSOLE_UNAVAILABLE' };
  if (state.process.status === 'starting' || state.compat.status === 'probing') {
    return { ok: false, reason: 'CONSOLE_NOT_READY' };
  }
  return { ok: true };
}
