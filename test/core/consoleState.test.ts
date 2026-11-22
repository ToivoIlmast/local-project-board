import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConsoleEntry, ConsoleEvent } from '../../src/contract/v1/console.js';
import {
  acceptsMessages,
  CONSOLE_PHASES,
  finalizeMessages,
  foldConsole,
  type ConsoleState,
} from '../../src/core/rules/console.js';
import { initialNormalizerState, normalize } from '../../src/server/cli/console/normalize.js';

const dir = join(process.cwd(), 'test', 'fixtures', 'claude-stream-json', '2.1.330');

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = uuid(1);
const B = uuid(2);
const C = uuid(3);
const M = uuid(4);

/** Wraps events as journal entries with growing `seq`. */
function journal(events: ConsoleEvent[], from = 1): ConsoleEntry[] {
  return events.map((event, i) => ({
    seq: from + i,
    at: '2026-01-01T00:00:00.000Z',
    source: 'runner' as const,
    event,
  }));
}

const userMessage = (messageId: string): ConsoleEvent => ({
  kind: 'user.message',
  origin: 'board',
  messageId,
  text: `text ${messageId.slice(-1)}`,
});
const lifecycle = (
  messageId: string,
  state: 'queued' | 'started' | 'completed' | 'cancelled',
): ConsoleEvent => ({ kind: 'user.lifecycle', messageId, state });
const turnStarted = (turn: number, userMessageIds: string[]): ConsoleEvent => ({
  kind: 'turn.started',
  turn,
  userMessageIds,
});
const turnEnded = (turn: number, isError = false, terminalReason?: string): ConsoleEvent => ({
  kind: 'turn.ended',
  turn,
  isError,
  denials: 0,
  ...(terminalReason === undefined ? {} : { terminalReason }),
});
const exited = (
  exitCode: number | null,
  signal: string | null,
  lastTurnOpen = false,
): ConsoleEvent => ({ kind: 'process.exited', exitCode, signal, lastTurnOpen });
const jobStarted = (jobId: string, backgrounded = true): ConsoleEvent => ({
  kind: 'job.started',
  jobId,
  jobType: 'local_agent',
  description: 'd',
  backgrounded,
});
const BOOT: ConsoleEvent[] = [{ kind: 'process.started', pid: 1 }, { kind: 'compat.passed' }];
const STARTED: ConsoleEvent = { kind: 'process.started', pid: 1 };

const fold = (...events: ConsoleEvent[]) => foldConsole(journal(events));
const statusOf = (state: ConsoleState, id: string) =>
  state.messages.find((m) => m.messageId === id)?.status;

/** Normalized events of a T16 fixture, with a `user.message` for each message it mentions. */
function fixtureEvents(name: string): ConsoleEvent[] {
  let state = initialNormalizerState();
  const events: ConsoleEvent[] = [];
  for (const line of readFileSync(join(dir, `${name}.stdout.ndjson`), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const out = normalize(state, JSON.parse(line));
    state = out.state;
    events.push(...out.events);
  }
  const ids: string[] = [];
  for (const e of events) {
    if (e.kind === 'user.lifecycle' && !ids.includes(e.messageId)) ids.push(e.messageId);
  }
  return [...BOOT, ...ids.map(userMessage), ...events];
}

describe('foldConsole', () => {
  it('starts as starting with nothing known', () => {
    const state = foldConsole([]);
    expect(state.process.status).toBe('starting');
    expect(state.compat.status).toBe('probing');
    expect(state.turn.status).toBe('none');
    expect(state.jobs).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(state.phase).toBe('starting');
  });

  describe('axes A and B', () => {
    it('follows process.started, close.requested, process.exited', () => {
      expect(fold(STARTED).process.status).toBe('running');
      expect(fold(STARTED, { kind: 'close.requested', reason: 'board' }).process.status).toBe(
        'closing',
      );
      expect(fold(STARTED, exited(0, null)).process).toMatchObject({
        status: 'exited',
        exitCode: 0,
        signal: null,
      });
    });

    it('marks kill.requested over running without a state of its own', () => {
      const state = fold(...BOOT, { kind: 'kill.requested', reason: 'board' });
      expect(state.process).toMatchObject({ status: 'running', killRequested: true });
    });

    it('does not leave exited again', () => {
      const state = fold(...BOOT, exited(0, null), { kind: 'process.started', pid: 2 });
      expect(state.process.status).toBe('exited');
    });

    it('probes, then compatible or incompatible; exit before the verdict is unknown', () => {
      expect(fold(STARTED).compat.status).toBe('probing');
      expect(fold(...BOOT).compat.status).toBe('compatible');
      expect(fold(STARTED, { kind: 'compat.failed', reason: 'no-init' }).compat).toEqual({
        status: 'incompatible',
        reason: 'no-init',
      });
      expect(fold(STARTED, exited(1, null)).compat.status).toBe('unknown');
    });

    it('can be told the run is lost, which no journal event says', () => {
      const state = foldConsole(journal(BOOT), { lost: true });
      expect(state.process.status).toBe('lost');
      expect(state.phase).toBe('failed');
    });
  });

  describe('message statuses (E)', () => {
    it('are monotonic: a regress is ignored', () => {
      const state = fold(
        ...BOOT,
        userMessage(A),
        lifecycle(A, 'queued'),
        lifecycle(A, 'started'),
        lifecycle(A, 'completed'),
        lifecycle(A, 'queued'),
        lifecycle(A, 'started'),
        lifecycle(A, 'cancelled'),
      );
      expect(statusOf(state, A)).toBe('completed');
    });

    it('can skip queued', () => {
      expect(statusOf(fold(...BOOT, userMessage(A), lifecycle(A, 'started')), A)).toBe('started');
    });

    it('ignores a lifecycle of an unknown messageId and a repeated user.message', () => {
      const state = fold(...BOOT, userMessage(A), userMessage(A), lifecycle(B, 'queued'), {
        kind: 'user.replayed',
        messageId: B,
      });
      expect(state.messages.map((m) => m.messageId)).toEqual([A]);
      expect(statusOf(state, A)).toBe('accepted');
    });

    it('keeps origin, text, acceptedSeq and replayed', () => {
      const state = fold(
        ...BOOT,
        { kind: 'user.message', origin: 'prompt', messageId: A, text: 'see handoff' },
        { kind: 'user.replayed', messageId: A },
      );
      expect(state.messages).toEqual([
        {
          messageId: A,
          origin: 'prompt',
          text: 'see handoff',
          acceptedSeq: 3,
          status: 'accepted',
          replayed: true,
        },
      ]);
    });

    it('takes the synthetic states written by the server', () => {
      const state = fold(
        ...BOOT,
        userMessage(A),
        userMessage(B),
        lifecycle(B, 'started'),
        { kind: 'user.lifecycle', messageId: A, state: 'undelivered', cause: 'exited' },
        { kind: 'user.lifecycle', messageId: B, state: 'interrupted', cause: 'exited' },
      );
      expect(statusOf(state, A)).toBe('undelivered');
      expect(statusOf(state, B)).toBe('interrupted');
    });
  });

  describe('join', () => {
    it('gives B and C new-turn with together=[B,C] (multi-message)', () => {
      const state = foldConsole(journal(fixtureEvents('multi-message')));
      const [a, b, c] = state.messages;
      expect(a?.join).toEqual({ how: 'new-turn', turn: 1, together: [a?.messageId] });
      expect(b?.join).toEqual({
        how: 'new-turn',
        turn: 2,
        together: [b?.messageId, c?.messageId],
      });
      expect(c?.join).toEqual(b?.join);
      expect(state.messages.map((m) => m.status)).toEqual(['completed', 'completed', 'completed']);
    });

    it('gives a message that arrived in a running turn joined-turn (mid-turn-message)', () => {
      const state = foldConsole(journal(fixtureEvents('mid-turn-message')));
      const [first, mid] = state.messages;
      expect(first?.join).toMatchObject({ how: 'new-turn', turn: 1 });
      expect(mid?.join).toEqual({ how: 'joined-turn', turn: 1, together: [mid?.messageId] });
      expect(state.messages.map((m) => m.status)).toEqual(['completed', 'completed']);
    });

    it('has no join for a started message no turn took, and none for internal turns', () => {
      const state = fold(...BOOT, userMessage(A), lifecycle(A, 'started'), turnStarted(1, []));
      expect(state.messages[0]?.join).toBeUndefined();
      expect(state.turn).toEqual({ status: 'active', turn: 1, origin: 'internal' });
    });

    it('matches by messageId, not by turn number', () => {
      const state = fold(
        ...BOOT,
        userMessage(A),
        userMessage(B),
        lifecycle(A, 'started'),
        turnStarted(7, [A]),
        turnEnded(3),
        lifecycle(B, 'started'),
        turnStarted(7, [B]),
      );
      expect(state.messages[0]?.join).toMatchObject({ how: 'new-turn', turn: 7 });
      expect(state.messages[1]?.join).toMatchObject({ how: 'new-turn', turn: 7, together: [B] });
    });
  });

  describe('turn (C)', () => {
    it('turn.ended without an active turn is a no-op', () => {
      expect(fold(...BOOT, turnEnded(1)).turn).toEqual({ status: 'none' });
    });

    it('turn.started while a turn is active makes a new active turn', () => {
      const state = fold(...BOOT, turnStarted(1, []), turnStarted(2, [A]));
      expect(state.turn).toEqual({ status: 'active', turn: 2, origin: 'user' });
    });

    it('remembers lastTurn after turn.ended', () => {
      const state = fold(...BOOT, turnStarted(1, []), turnEnded(1, true, 'api_error'));
      expect(state.turn).toEqual({
        status: 'none',
        lastTurn: { turn: 1, isError: true, terminalReason: 'api_error' },
      });
    });
  });

  describe('background jobs (D)', () => {
    it('job.updated and job.notified do not remove a job; job.ended does', () => {
      const base = [...BOOT, jobStarted('j1')];
      expect(fold(...base).jobs).toEqual(['j1']);
      expect(fold(...base, { kind: 'job.updated', jobId: 'j1', status: 'killed' }).jobs).toEqual([
        'j1',
      ]);
      expect(fold(...base, { kind: 'job.updated', jobId: 'j1', status: 'completed' }).jobs).toEqual(
        ['j1'],
      );
      expect(fold(...base, { kind: 'job.notified', jobId: 'j1', status: 'failed' }).jobs).toEqual([
        'j1',
      ]);
      expect(fold(...base, { kind: 'job.ended', jobId: 'j1', status: 'completed' }).jobs).toEqual(
        [],
      );
    });

    it('job.ended for a missing job is a no-op', () => {
      const state = fold(...BOOT, jobStarted('j1'), {
        kind: 'job.ended',
        jobId: 'zz',
        status: 'completed',
      });
      expect(state.jobs).toEqual(['j1']);
    });

    it('does not count a foreground job', () => {
      expect(fold(...BOOT, jobStarted('j1', false)).jobs).toEqual([]);
    });

    it('jobs.background overrides what came before, in both directions', () => {
      const base = [...BOOT, jobStarted('j1'), jobStarted('j2')];
      expect(fold(...base, { kind: 'jobs.background', jobIds: ['j3'] }).jobs).toEqual(['j3']);
      expect(
        fold(
          ...base,
          { kind: 'job.ended', jobId: 'j1', status: 'completed' },
          { kind: 'jobs.background', jobIds: ['j1', 'j2'] },
        ).jobs.sort(),
      ).toEqual(['j1', 'j2']);
      expect(fold(...base, { kind: 'jobs.background', jobIds: [] }).jobs).toEqual([]);
    });

    it('clears at process.exited', () => {
      expect(fold(...BOOT, jobStarted('j1'), exited(0, null)).jobs).toEqual([]);
    });
  });

  describe('phase', () => {
    it('subagent: background after the first turn.ended, idle after the empty snapshot, working on the second turn', () => {
      const events = fixtureEvents('subagent');
      const at = (pred: (e: ConsoleEvent) => boolean) => events.findIndex(pred);
      const firstEnded = at((e) => e.kind === 'turn.ended');
      const emptySnapshot = at((e) => e.kind === 'jobs.background' && e.jobIds.length === 0);
      const secondStart = at((e) => e.kind === 'turn.started' && e.turn === 2);
      const upTo = (n: number) => foldConsole(journal(events.slice(0, n + 1)));

      expect(upTo(firstEnded - 1).phase).toBe('working');
      expect(upTo(firstEnded).phase).toBe('background');
      expect(upTo(firstEnded).jobs).toHaveLength(1);
      expect(upTo(emptySnapshot).phase).toBe('idle');
      expect(upTo(secondStart - 1).phase).toBe('idle');
      expect(upTo(secondStart).phase).toBe('working');
      expect(foldConsole(journal(events)).phase).toBe('idle');
    });

    it('stays background through events that only mention the job, until the empty snapshot', () => {
      const state = fold(
        ...BOOT,
        jobStarted('j1'),
        { kind: 'job.updated', jobId: 'j1', status: 'killed' },
        { kind: 'job.notified', jobId: 'j1', status: 'killed' },
        turnStarted(1, []),
        turnEnded(1),
      );
      expect(state.phase).toBe('background');
      const settled = fold(...BOOT, jobStarted('j1'), { kind: 'jobs.background', jobIds: [] });
      expect(settled.phase).toBe('idle');
    });

    it('does not depend on delivery: accepted -> idle, awaitingDelivery 1', () => {
      const state = fold(...BOOT, userMessage(A));
      expect(state.phase).toBe('idle');
      expect(state.counters).toEqual({ awaitingDelivery: 1, pendingProcessing: 0, inProgress: 0 });
    });

    it('does not depend on delivery: queued without a turn -> idle, pendingProcessing 1', () => {
      const state = fold(...BOOT, userMessage(A), lifecycle(A, 'queued'));
      expect(state.phase).toBe('idle');
      expect(state.counters).toEqual({ awaitingDelivery: 0, pendingProcessing: 1, inProgress: 0 });
    });

    it('started + turn.started -> working, inProgress 1', () => {
      const state = fold(
        ...BOOT,
        userMessage(A),
        lifecycle(A, 'queued'),
        lifecycle(A, 'started'),
        turnStarted(1, [A]),
      );
      expect(state.phase).toBe('working');
      expect(state.counters).toEqual({ awaitingDelivery: 0, pendingProcessing: 0, inProgress: 1 });
    });

    it('is starting until the process runs and the compatibility is known', () => {
      expect(fold(STARTED).phase).toBe('starting');
      expect(fold(...BOOT).phase).toBe('idle');
    });

    it('is closing after close.requested', () => {
      expect(fold(...BOOT, { kind: 'close.requested', reason: 'board' }).phase).toBe('closing');
    });

    it('is ended after a clean exit, failed otherwise', () => {
      expect(fold(...BOOT, exited(0, null)).phase).toBe('ended');
      expect(fold(...BOOT, exited(1, null)).phase).toBe('failed');
      expect(fold(...BOOT, exited(null, 'SIGTERM')).phase).toBe('failed');
      expect(fold(...BOOT, turnStarted(1, []), exited(0, null, true)).phase).toBe('failed');
      expect(fold(STARTED, { kind: 'compat.failed', reason: 'r' }, exited(0, null)).phase).toBe(
        'failed',
      );
    });

    it('is not failed after an API error while the process lives (api-error fixture)', () => {
      const state = foldConsole(journal(fixtureEvents('api-error')));
      expect(statusOf(state, state.messages[0]!.messageId)).toBe('cancelled');
      expect(state.turn).toMatchObject({
        status: 'none',
        lastTurn: { isError: true, terminalReason: 'api_error' },
      });
      expect(state.phase).toBe('idle');
    });

    it('has no phase of waiting for an answer', () => {
      expect([...CONSOLE_PHASES].sort()).toEqual(
        ['background', 'closing', 'ended', 'failed', 'idle', 'starting', 'working'].sort(),
      );
      expect(CONSOLE_PHASES.some((p) => /await|wait|input|answer/i.test(p))).toBe(false);
    });
  });

  describe('counters', () => {
    it('put each non-terminal message in exactly one counter, terminal ones in none', () => {
      const [acc, que, sta, com, can, und, int] = [11, 12, 13, 14, 15, 16, 17].map(uuid) as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const state = fold(
        ...BOOT,
        ...[acc, que, sta, com, can, und, int].map(userMessage),
        lifecycle(que, 'queued'),
        lifecycle(sta, 'started'),
        lifecycle(com, 'started'),
        lifecycle(com, 'completed'),
        lifecycle(can, 'queued'),
        lifecycle(can, 'cancelled'),
        { kind: 'user.lifecycle', messageId: und, state: 'undelivered', cause: 'exited' },
        lifecycle(int, 'started'),
        { kind: 'user.lifecycle', messageId: int, state: 'interrupted', cause: 'lost' },
      );
      expect(statusOf(state, acc)).toBe('accepted');
      expect(state.counters).toEqual({ awaitingDelivery: 1, pendingProcessing: 1, inProgress: 1 });
    });
  });
});

describe('process end: finalizeMessages', () => {
  it.each([
    ['sigint', 'SIGINT'],
    ['parent-death', 'SIGKILL'],
  ])('%s: exit without a result interrupts the turn and the started message', (name, signal) => {
    const accepted = uuid(99);
    const events: ConsoleEvent[] = [
      ...fixtureEvents(name),
      userMessage(accepted),
      exited(null, signal, true),
    ];
    const state = foldConsole(journal(events));
    expect(state.turn.status).toBe('interrupted');
    expect(state.phase).toBe('failed');
    expect(state.messages[0]?.status).toBe('started');

    expect(finalizeMessages(state, 'exited')).toEqual([
      {
        kind: 'user.lifecycle',
        messageId: state.messages[0]!.messageId,
        state: 'interrupted',
        cause: 'exited',
      },
      { kind: 'user.lifecycle', messageId: accepted, state: 'undelivered', cause: 'exited' },
    ]);
  });

  it('turns accepted and queued into undelivered, started into interrupted, leaves terminals', () => {
    const state = fold(
      ...BOOT,
      userMessage(A),
      userMessage(B),
      userMessage(C),
      userMessage(M),
      lifecycle(B, 'queued'),
      lifecycle(C, 'started'),
      lifecycle(M, 'started'),
      lifecycle(M, 'completed'),
    );
    const byId = Object.fromEntries(
      finalizeMessages(state, 'lost').map((e) => [e.messageId, e] as const),
    );
    expect(byId[A]).toEqual({
      kind: 'user.lifecycle',
      messageId: A,
      state: 'undelivered',
      cause: 'lost',
    });
    expect(byId[B]).toMatchObject({ state: 'undelivered', cause: 'lost' });
    expect(byId[C]).toMatchObject({ state: 'interrupted', cause: 'lost' });
    expect(byId[M]).toBeUndefined();
  });

  it('a message with no lifecycle stays accepted, and is undelivered after the exit', () => {
    const state = fold(...BOOT, userMessage(A), exited(0, null));
    expect(statusOf(state, A)).toBe('accepted');
    expect(finalizeMessages(state, 'exited')).toHaveLength(1);
  });

  it('is idempotent: folding its events in gives nothing more', () => {
    const base = [
      ...BOOT,
      userMessage(A),
      userMessage(B),
      lifecycle(B, 'started'),
      exited(null, 'SIGINT', true),
    ];
    const state = foldConsole(journal(base));
    const first = finalizeMessages(state, 'exited');
    expect(first).toHaveLength(2);
    expect(finalizeMessages(state, 'exited')).toEqual(first);
    const after = foldConsole(journal([...base, ...first]));
    expect(finalizeMessages(after, 'exited')).toEqual([]);
    expect(after.messages.map((m) => m.status)).toEqual(['undelivered', 'interrupted']);
    expect(after.counters).toEqual({ awaitingDelivery: 0, pendingProcessing: 0, inProgress: 0 });
  });
});

describe('acceptsMessages', () => {
  const SESSION = '33333333-3333-4333-8333-333333333333';
  const ids = { runId: 4, sessionId: SESSION };
  const run = { runId: 4, sessionId: SESSION };
  const running = () => fold(...BOOT);
  const notReady = { ok: false, reason: 'CONSOLE_NOT_READY' };
  const unavailable = { ok: false, reason: 'CONSOLE_UNAVAILABLE' };
  const stale = { ok: false, reason: 'STALE_AI_RUN' };

  it('is ok for a running, compatible session of the current run', () => {
    expect(acceptsMessages(running(), run, ids)).toEqual({ ok: true });
  });

  it('refuses a starting or probing session as not ready', () => {
    expect(acceptsMessages(foldConsole([]), run, ids)).toEqual(notReady);
    expect(acceptsMessages(fold(STARTED), run, ids)).toEqual(notReady);
    expect(acceptsMessages(fold({ kind: 'compat.passed' }), run, ids)).toEqual(notReady);
  });

  it('refuses incompatible, closing, exited, lost and ended runs as unavailable', () => {
    expect(
      acceptsMessages(fold(STARTED, { kind: 'compat.failed', reason: 'r' }), run, ids),
    ).toEqual(unavailable);
    expect(
      acceptsMessages(fold(...BOOT, { kind: 'close.requested', reason: 'board' }), run, ids),
    ).toEqual(unavailable);
    expect(acceptsMessages(fold(...BOOT, exited(0, null)), run, ids)).toEqual(unavailable);
    expect(acceptsMessages(foldConsole(journal(BOOT), { lost: true }), run, ids)).toEqual(
      unavailable,
    );
    expect(
      acceptsMessages(running(), { ...run, endedAt: '2026-01-01T00:00:00.000Z' }, ids),
    ).toEqual(unavailable);
  });

  it('refuses another runId or sessionId as stale', () => {
    expect(acceptsMessages(running(), run, { ...ids, runId: 5 })).toEqual(stale);
    expect(acceptsMessages(running(), run, { ...ids, sessionId: uuid(7) })).toEqual(stale);
    expect(acceptsMessages(running(), { ...run, runId: 3 }, ids)).toEqual(stale);
  });

  it('does not read aiRun.state: a reported run with a live process is ok', () => {
    for (const state of ['working', 'finished', 'failed', 'needs-review']) {
      const reported = { ...run, state };
      expect(acceptsMessages(running(), reported, ids)).toEqual({ ok: true });
    }
  });
});

describe('compatibility with the C3 contract', () => {
  it('folds the events of every normalized fixture, typed as contract entries', () => {
    for (const name of ['subagent', 'multi-message', 'mid-turn-message', 'api-error', 'tools']) {
      const entries: ConsoleEntry[] = journal(fixtureEvents(name));
      expect(foldConsole(entries).messages.length).toBeGreaterThanOrEqual(0);
    }
  });
});
