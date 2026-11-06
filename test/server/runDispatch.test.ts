import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import { createRunDispatch, type RunDispatch } from '../../src/server/http/runs.js';

/**
 * The reservation of a runner for a work run (ADR-0029 T94, K6 step 2, K7 I4), without a socket:
 * which runner is taken, that nobody else can take it until it is sent or released, and that a
 * runner whose connection closed is never told anything.
 */

const TOKEN = 'the-token';

interface FakeRunner {
  request: EventEmitter & Request;
  response: EventEmitter & Response;
  /** What the stream carried when it was ended; undefined while it is open. */
  ended: () => string | undefined;
  close: () => void;
}

function waitOn(dispatch: RunDispatch, query: Record<string, string> = {}): FakeRunner {
  const request = Object.assign(new EventEmitter(), {
    headers: { authorization: `Bearer ${TOKEN}` },
    query,
  }) as unknown as EventEmitter & Request;
  let ended: string | undefined;
  const response = Object.assign(new EventEmitter(), {
    status: () => response,
    set: () => response,
    flushHeaders: () => undefined,
    write: () => true,
    end: (chunk: string) => {
      ended = chunk;
      return response;
    },
  }) as unknown as EventEmitter & Response;
  dispatch.handler(TOKEN, { heartbeatMs: 60_000 })(request, response, (() => {}) as NextFunction);
  return {
    request,
    response,
    ended: () => ended,
    close: () => response.emit('close'),
  };
}

const request = { taskId: 'T1', agent: 'claude-code' as const };
const event = (runner: FakeRunner): unknown =>
  JSON.parse((runner.ended() ?? '').replace(/^data: /, '').trim());

describe('reserve: one waiting runner, for one request of work (K6, I4)', () => {
  it('takes the runner that came last, and tells it nothing until send', () => {
    const dispatch = createRunDispatch();
    const first = waitOn(dispatch);
    const last = waitOn(dispatch, { signals: 'run-failure' });

    const reserved = dispatch.reserve(request);

    expect(reserved?.reports).toBe(true);
    expect(last.ended()).toBeUndefined();
    expect(reserved?.send('5d2f7a10-1c3b-4d5e-8f90-a1b2c3d4e5f6')).toBe(true);
    expect(event(last)).toEqual({
      type: 'run.requested',
      ...request,
      requestId: '5d2f7a10-1c3b-4d5e-8f90-a1b2c3d4e5f6',
    });
    expect(first.ended()).toBeUndefined();
  });

  it('is exclusive: a reserved runner is not reserved again, nor handed a check (INVARIANT)', () => {
    const dispatch = createRunDispatch();
    waitOn(dispatch, { accepts: 'check' });

    const one = dispatch.reserve(request);
    const two = dispatch.reserve({ taskId: 'T2', agent: 'claude-code' });

    expect(one).toBeDefined();
    expect(two).toBeUndefined();
    expect(dispatch.hand({ taskId: 'T2', agent: 'claude-code', kind: 'check' })).toBe('nobody');
  });

  it('two runners, two reservations: never the same runner', () => {
    const dispatch = createRunDispatch();
    const a = waitOn(dispatch, { signals: 'run-failure' });
    const b = waitOn(dispatch, { signals: 'run-failure' });

    const one = dispatch.reserve(request);
    const two = dispatch.reserve({ taskId: 'T2', agent: 'claude-code' });
    one?.send('11111111-1111-4111-8111-111111111111');
    two?.send('22222222-2222-4222-8222-222222222222');

    expect([a.ended(), b.ended()].every((chunk) => chunk !== undefined)).toBe(true);
    expect(new Set([event(a), event(b)].map((e) => (e as { taskId: string }).taskId))).toEqual(
      new Set(['T1', 'T2']),
    );
  });

  it('release puts the runner back as it was: told nothing, and reserved again', () => {
    const dispatch = createRunDispatch();
    const runner = waitOn(dispatch);

    dispatch.reserve(request)?.release();
    const again = dispatch.reserve(request);

    expect(runner.ended()).toBeUndefined();
    expect(again).toBeDefined();
  });

  it('a runner whose connection closed while reserved is sent nothing and not put back (K6 step 4)', () => {
    const dispatch = createRunDispatch();
    const runner = waitOn(dispatch);
    const reserved = dispatch.reserve(request);

    runner.close();

    expect(reserved?.send('33333333-3333-4333-8333-333333333333')).toBe(false);
    expect(runner.ended()).toBeUndefined();
    reserved?.release();
    expect(dispatch.reserve(request)).toBeUndefined();
  });

  it('an earlier runner gets the event without requestId, and reports: false (K11)', () => {
    const dispatch = createRunDispatch();
    const runner = waitOn(dispatch, { accepts: 'check,research' });

    const reserved = dispatch.reserve(request);
    reserved?.send('44444444-4444-4444-8444-444444444444');

    expect(reserved?.reports).toBe(false);
    expect(event(runner)).toEqual({ type: 'run.requested', ...request });
  });
});
