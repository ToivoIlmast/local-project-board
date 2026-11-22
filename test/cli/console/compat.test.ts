import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCompatProbe, type CompatResult } from '../../../src/server/cli/console/compat.js';

const dir = join(process.cwd(), 'test', 'fixtures', 'claude-stream-json', '2.1.330');

type Msg = Record<string, unknown>;

const FIXTURES = [
  'api-error',
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

const lines = (file: string): Msg[] =>
  readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Msg);

const stdout = (name: string) => lines(`${name}.stdout.ndjson`);
// The probe prompt is the first message written to stdin.
const promptUuid = (name: string) => lines(`${name}.stdin.ndjson`)[0]?.['uuid'] as string;
const sessionOf = (messages: Msg[]) =>
  (messages.find((m) => typeof m['session_id'] === 'string') as Msg)['session_id'] as string;

function clock() {
  let t = 1_000;
  return { now: () => t, set: (v: number) => (t = v), advance: (ms: number) => (t += ms) };
}

function makeProbe(messages: Msg[], uuid: string, sessionId = sessionOf(messages)) {
  const c = clock();
  const probe = createCompatProbe({ sessionId, promptUuid: uuid, now: c.now });
  return { probe, c };
}

/** Feeds messages one by one, returns the status after each and the index where it left `probing`. */
function feed(messages: Msg[], uuid: string, sessionId?: string) {
  const { probe, c } = makeProbe(messages, uuid, sessionId);
  let decidedAt = -1;
  let last: CompatResult = probe.observe({ type: 'noop-start-check' });
  messages.forEach((m, i) => {
    last = probe.observe(m);
    if (decidedAt < 0 && last.status !== 'probing') decidedAt = i;
  });
  return { probe, c, last, decidedAt };
}

describe('fixtures of claude 2.1.330', () => {
  describe.each(FIXTURES)('%s', (name) => {
    it('passes', () => {
      const messages = stdout(name);
      const { last } = feed(messages, promptUuid(name));
      expect(last.status).toBe('passed');
    });
  });

  it('bad-input: no messages at all -> failed by timeout', () => {
    const { probe, c } = makeProbe([], 'x', 'sid');
    expect(probe.observe({ type: 'noop' }).status).toBe('probing');
    c.advance(14_999);
    expect(probe.tick(c.now()).status).toBe('probing');
    c.advance(1);
    expect(probe.tick(c.now())).toEqual({ status: 'failed', reason: 'no-lifecycle-for-prompt' });
    const empty = stdout('bad-input');
    expect(feed(empty, 'x', 'sid').last.status).toBe('probing');
  });

  it('api-error: passes before result, a later is_error result does not change it', () => {
    const messages = stdout('api-error');
    const resultAt = messages.findIndex((m) => m['type'] === 'result');
    const { probe, decidedAt, last } = feed(messages, promptUuid('api-error'));
    expect(messages[resultAt]?.['is_error']).toBe(true);
    expect(decidedAt).toBeGreaterThanOrEqual(0);
    expect(decidedAt).toBeLessThan(resultAt);
    expect(last).toEqual({ status: 'passed' });
    expect(probe.tick(10 ** 9)).toEqual({ status: 'passed' });
  });
});

describe('moment of confirmation', () => {
  it.each(['tools', 'mid-turn-message'])('%s: passed before the first result', (name) => {
    const messages = stdout(name);
    const firstResult = messages.findIndex((m) => m['type'] === 'result');
    const { decidedAt, last } = feed(messages, promptUuid(name));
    expect(last.status).toBe('passed');
    expect(firstResult).toBeGreaterThan(0);
    expect(decidedAt).toBeLessThan(firstResult);
    // exactly when the replay of the prompt arrives
    expect(messages[decidedAt]?.['isReplay']).toBe(true);
  });
});

describe('protocol mutations', () => {
  const base = () => stdout('tools');
  const uuid = promptUuid('tools');
  const isInit = (m: Msg) => m['subtype'] === 'init';

  it('no msg_lifecycle_v1 -> failed:no-lifecycle immediately at init', () => {
    const messages = base().map((m) =>
      isInit(m)
        ? {
            ...m,
            capabilities: (m['capabilities'] as string[]).filter((c) => c !== 'msg_lifecycle_v1'),
          }
        : m,
    );
    const { decidedAt, last } = feed(messages, uuid);
    expect(last).toEqual({ status: 'failed', reason: 'no-lifecycle' });
    expect(messages[decidedAt]).toBe(messages.find(isInit));
  });

  it('capabilities that is not an array -> failed:no-lifecycle', () => {
    const messages = base().map((m) =>
      isInit(m) ? { ...m, capabilities: 'msg_lifecycle_v1' } : m,
    );
    expect(feed(messages, uuid).last).toEqual({ status: 'failed', reason: 'no-lifecycle' });
  });

  it('no queued event -> failed by the 15 s timeout', () => {
    const messages = base().filter((m) => !(m['state'] === 'queued'));
    const { probe, c, last } = feed(messages, uuid);
    expect(last.status).toBe('probing');
    c.advance(14_999);
    expect(probe.tick(c.now()).status).toBe('probing');
    c.advance(1);
    expect(probe.tick(c.now())).toEqual({ status: 'failed', reason: 'no-lifecycle-for-prompt' });
  });

  it('no replay -> failed:no-replay once the handshake timeout passes', () => {
    const messages = base().filter((m) => !(m['isReplay'] === true));
    const { probe, c, last } = feed(messages, uuid);
    expect(last.status).toBe('probing');
    c.advance(119_999);
    expect(probe.tick(c.now()).status).toBe('probing');
    c.advance(1);
    expect(probe.tick(c.now())).toEqual({ status: 'failed', reason: 'no-replay' });
  });

  it('no init within the handshake timeout -> failed', () => {
    const messages = base().filter((m) => !isInit(m));
    const { probe, c } = feed(messages, uuid);
    c.advance(120_000);
    expect(probe.tick(c.now()).status).toBe('failed');
  });

  it('another prompt uuid -> failed:id-mismatch', () => {
    const { last } = feed(base(), '00000000-0000-4000-8000-000000000000');
    expect(last).toEqual({ status: 'failed', reason: 'id-mismatch' });
  });

  it('a replay with another uuid before the prompt replay -> failed:id-mismatch', () => {
    const messages = base().map((m) =>
      m['isReplay'] === true ? { ...m, uuid: '00000000-0000-4000-8000-000000000000' } : m,
    );
    expect(feed(messages, uuid).last).toEqual({ status: 'failed', reason: 'id-mismatch' });
  });

  it('another session_id -> failed:id-mismatch', () => {
    const { last } = feed(base(), uuid, '00000000-0000-4000-8000-000000000001');
    expect(last).toEqual({ status: 'failed', reason: 'id-mismatch' });
  });

  it('a stray line with a different session_id during probing -> failed:id-mismatch', () => {
    const messages = stdout('tools');
    const { probe } = makeProbe(messages, promptUuid('tools'));
    probe.observe(messages[0] as Msg);
    expect(probe.observe({ type: 'assistant', session_id: 'other' })).toEqual({
      status: 'failed',
      reason: 'id-mismatch',
    });
  });

  it('is_error removed from the first result -> stays passed', () => {
    const messages = stdout('api-error').map((m) => {
      if (m['type'] !== 'result') return m;
      const { is_error: _drop, ...rest } = m;
      return rest;
    });
    const { probe, last } = feed(messages, promptUuid('api-error'));
    expect(last).toEqual({ status: 'passed' });
    expect(probe.tick(10 ** 9)).toEqual({ status: 'passed' });
  });

  it('failed is final: later good messages do not revive it', () => {
    const messages = stdout('tools');
    const { probe } = makeProbe(messages, promptUuid('tools'), 'wrong');
    for (const m of messages) probe.observe(m);
    expect(probe.observe(messages[0] as Msg).status).toBe('failed');
    expect(probe.tick(0).status).toBe('failed');
  });
});

describe('unknown data', () => {
  it('unknown event types, subtypes and capabilities do not affect the result', () => {
    const messages = stdout('tools').flatMap((m) => {
      const out: Msg[] = [m];
      if (m['subtype'] === 'init') {
        out[0] = { ...m, capabilities: [...(m['capabilities'] as string[]), 'brand_new_v9'] };
      }
      out.push({ type: 'from_the_future', session_id: m['session_id'], payload: 1 });
      out.push({ type: 'system', subtype: 'new_subtype', session_id: m['session_id'] });
      return out;
    });
    expect(feed(messages, promptUuid('tools')).last).toEqual({ status: 'passed' });
  });

  it('empty objects and lines without session_id are ignored', () => {
    const { probe } = makeProbe([], 'x', 'sid');
    expect(probe.observe({}).status).toBe('probing');
    expect(probe.observe({ type: 'user', message: 'x' }).status).toBe('probing');
  });
});

describe('timeouts use the injected clock only', () => {
  it('tick(now) with the passed time decides, regardless of the real clock', () => {
    const c = clock();
    const probe = createCompatProbe({ sessionId: 's', promptUuid: 'p', now: c.now });
    expect(probe.tick(c.now() + 14_999).status).toBe('probing');
    expect(probe.tick(c.now() + 15_000).status).toBe('failed');
  });

  it('a probe that passed never times out', () => {
    const { probe } = feed(stdout('tools'), promptUuid('tools'));
    expect(probe.tick(10 ** 12)).toEqual({ status: 'passed' });
  });
});
