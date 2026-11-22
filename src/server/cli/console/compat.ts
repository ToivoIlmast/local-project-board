/**
 * Compatibility probe of Claude Code with Console mode (plan §6, task C6).
 *
 * A pure state machine with an injected clock: no timers, no I/O, no process control. The caller
 * feeds it every parsed stdout object of the first turn (`observe`) and calls `tick` from its own
 * timer. The handshake is the only gate; the shape of `result` is not checked here (the normalizer
 * reports `protocol_malformed`, an `is_error` result is a turn error, not incompatibility).
 */

export type CompatFailureReason =
  'no-lifecycle' | 'no-lifecycle-for-prompt' | 'no-replay' | 'id-mismatch' | 'no-init';

export interface CompatResult {
  status: 'probing' | 'passed' | 'failed';
  reason?: CompatFailureReason;
}

export interface CompatProbe {
  /** Takes one parsed stdout object of Claude Code. Unknown shapes are ignored. */
  observe(message: Record<string, unknown>): CompatResult;
  /** Checks the timeouts against `now` (ms); `now` defaults to the injected clock. */
  tick(now?: number): CompatResult;
}

/** `queued` for the prompt must arrive within this time from the start of the probe. */
export const QUEUED_TIMEOUT_MS = 15_000;
/** `init`, `started` and the replay must arrive within this time from the start of the probe. */
export const HANDSHAKE_TIMEOUT_MS = 120_000;

const LIFECYCLE_CAPABILITY = 'msg_lifecycle_v1';

export function createCompatProbe(options: {
  sessionId: string;
  promptUuid: string;
  now: () => number;
}): CompatProbe {
  const { sessionId, promptUuid } = options;
  const startedAt = options.now();
  let result: CompatResult = { status: 'probing' };
  let init = false;
  let queued = false;
  let started = false;
  let replay = false;

  const fail = (reason: CompatFailureReason): CompatResult => {
    result = { status: 'failed', reason };
    return result;
  };

  const settle = (): CompatResult => {
    if (init && queued && started && replay) result = { status: 'passed' };
    return result;
  };

  return {
    observe(message) {
      if (result.status !== 'probing') return result;

      const sid = message['session_id'];
      if (typeof sid === 'string' && sid !== sessionId) return fail('id-mismatch');

      if (message['type'] === 'system' && message['subtype'] === 'init') {
        if (init) return result;
        const caps = message['capabilities'];
        if (!Array.isArray(caps) || !caps.includes(LIFECYCLE_CAPABILITY)) {
          return fail('no-lifecycle');
        }
        const uuids = message['user_message_uuids'];
        if (!Array.isArray(uuids) || !uuids.includes(promptUuid)) return fail('id-mismatch');
        init = true;
      } else if (message['type'] === 'command_lifecycle') {
        if (message['command_uuid'] === promptUuid) {
          if (message['state'] === 'queued') queued = true;
          else if (message['state'] === 'started') started = true;
        }
      } else if (message['type'] === 'user' && message['isReplay'] === true) {
        if (message['uuid'] !== promptUuid) {
          if (!replay) return fail('id-mismatch');
        } else {
          replay = true;
        }
      }
      return settle();
    },

    tick(now = options.now()) {
      if (result.status !== 'probing') return result;
      const elapsed = now - startedAt;
      if (!queued && elapsed >= QUEUED_TIMEOUT_MS) return fail('no-lifecycle-for-prompt');
      if (elapsed >= HANDSHAKE_TIMEOUT_MS) {
        if (!init) return fail('no-init');
        if (!started) return fail('no-lifecycle-for-prompt');
        return fail('no-replay');
      }
      return result;
    },
  };
}
